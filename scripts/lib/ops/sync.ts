import type { Database } from "bun:sqlite";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import ora from "ora";
import {
  apiHeaders,
  EMBED_BASE_URL,
  EMBED_DIM,
  CHUNK_SIZE,
  MIN_CHUNK_TOKENS,
  HISTORY_FILE,
  PROJECTS_DIR,
  requireEmbedConfig,
} from "../env.ts";
import { chunkMessages } from "../chunks.ts";
import { stats } from "./health.ts";
import {
  extractText,
  extractTools,
  extractToolCalls,
  tsToUnix,
  bar,
  sha256,
  embed,
} from "../utils.ts";
import { type Result, ok, inferenceUnreachable } from "../types.ts";

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  const { values, error } = Bun.JSONL.parseChunk(readFileSync(path));
  if (error) console.error(`JSONL parse error in ${path}: ${error.message}`);
  return values;
}

function syncLog(db: Database, onProgress?: (msg: string) => void) {
  const sessionMeta = new Map<
    string,
    { project: string; display: string | null }
  >();
  const history = readJsonl(HISTORY_FILE);
  for (const entry of history) {
    if (!entry.sessionId || sessionMeta.has(entry.sessionId)) continue;
    sessionMeta.set(entry.sessionId, {
      project: entry.project ?? "",
      display: entry.display ?? null,
    });
  }

  const getSync = db.prepare(
    "SELECT mtime, size FROM sync_state WHERE file_path = ?",
  );
  const upsertSync = db.prepare(
    "INSERT OR REPLACE INTO sync_state (file_path, mtime, size) VALUES (?, ?, ?)",
  );
  const insertLog = db.prepare(`
    INSERT INTO log (session_id, project, display, uuid, parent_uuid, role, text, tools, tool_calls, model, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteBySession = db.prepare("DELETE FROM log WHERE session_id = ?");
  const countBySession = db.prepare(
    "SELECT count(*) as n FROM log WHERE session_id = ?",
  );

  if (!existsSync(PROJECTS_DIR))
    return { messages: 0, newSessions: 0, updatedSessions: 0 };

  let total = 0;
  let newSessions = 0;
  let updatedSessions = 0;
  const projectDirs = readdirSync(PROJECTS_DIR);

  const allFiles: { dir: string; file: string }[] = [];
  for (const dir of projectDirs) {
    const dirPath = join(PROJECTS_DIR, dir);
    try {
      for (const f of readdirSync(dirPath)) {
        if (f.endsWith(".jsonl")) allFiles.push({ dir, file: f });
      }
    } catch {
      continue;
    }
  }

  let processed = 0;
  for (const { dir, file } of allFiles) {
    processed++;
    onProgress?.(`${processed}/${allFiles.length} files`);
    const filePath = join(PROJECTS_DIR, dir, file);
    const stat = statSync(filePath);
    const mtime = Math.floor(stat.mtimeMs);
    const size = stat.size;

    const prev = getSync.get(filePath) as any;
    if (prev && prev.mtime === mtime && prev.size === size) continue;

    const sessionId = file.replace(/\.jsonl$/, "");
    const meta = sessionMeta.get(sessionId);
    const project = meta?.project ?? dir.replace(/^-/, "").replace(/-/g, "/");
    const display = meta?.display ?? null;

    const lines = readJsonl(filePath);

    const batch = db.transaction(() => {
      let prevCount = 0;
      if (prev) {
        prevCount = (countBySession.get(sessionId) as any).n;
        deleteBySession.run(sessionId);
      } else {
        newSessions++;
      }
      updatedSessions++;

      let inserted = 0;
      for (const entry of lines) {
        if (entry.type !== "user" && entry.type !== "assistant") continue;
        const text = extractText(entry.message?.content);
        insertLog.run(
          entry.sessionId ?? sessionId,
          project,
          display,
          entry.uuid ?? null,
          entry.parentUuid ?? null,
          entry.type,
          text || null,
          extractTools(entry.message?.content),
          extractToolCalls(entry.message?.content),
          entry.message?.model ?? null,
          tsToUnix(entry.timestamp),
        );
        inserted++;
      }
      total += inserted - prevCount;
      upsertSync.run(filePath, mtime, size);
    });
    batch();
  }
  return { messages: total, newSessions, updatedSessions };
}

async function syncChunks(db: Database, onProgress?: (msg: string) => void) {
  const sessions = db
    .prepare(
      `SELECT session_id, project FROM (
        -- sessions with log entries but no chunks (only if enough text to chunk)
        SELECT l.session_id, l.project
        FROM log l
        LEFT JOIN chunks c ON c.session_id = l.session_id
        WHERE l.text IS NOT NULL AND c.id IS NULL
          AND l.role IN ('user','assistant')
          AND (l.tools IS NULL OR l.tools = '[]')
        GROUP BY l.session_id
        HAVING sum(length(l.text)) >= ${Math.floor(MIN_CHUNK_TOKENS * 3.5)}
        UNION
        -- chunks missing their embedding vector
        SELECT DISTINCT c.session_id, c.project
        FROM chunks c
        WHERE c.id NOT IN (SELECT rowid FROM chunks_vec)
      )`,
    )
    .all() as any[];

  if (!sessions.length) {
    onProgress?.(`0 sessions`);
    return 0;
  }

  const getMessages = db.prepare(
    `SELECT role, text, timestamp FROM log
     WHERE session_id = ? AND text IS NOT NULL AND role IN ('user','assistant')
       AND (tools IS NULL OR tools = '[]')
     ORDER BY timestamp`,
  );
  const insertChunk = db.prepare(
    `INSERT OR REPLACE INTO chunks (session_id, chunk_index, project, text, hash, ts_start, ts_end)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const hasVec = db.prepare("SELECT rowid FROM chunks_vec WHERE rowid = ?");
  const insertVec = db.prepare(
    "INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)",
  );
  const replaceVec = db.prepare(
    "UPDATE chunks_vec SET embedding = ? WHERE rowid = ?",
  );
  const deleteOldChunks = db.prepare(
    "DELETE FROM chunks WHERE session_id = ? AND chunk_index >= ?",
  );

  let embedded = 0;
  let bytesEmbedded = 0;
  let sessionNum = 0;
  for (const session of sessions) {
    sessionNum++;
    const rows = getMessages.all(session.session_id) as any[];
    if (!rows.length) continue;

    let i = 0;
    for (const chunk of chunkMessages(rows, CHUNK_SIZE, MIN_CHUNK_TOKENS)) {
      const hash = sha256(chunk.text);

      insertChunk.run(
        session.session_id,
        i,
        session.project,
        chunk.text,
        hash,
        chunk.ts_start,
        chunk.ts_end,
      );

      const chunkRow = db
        .prepare(
          "SELECT id FROM chunks WHERE session_id = ? AND chunk_index = ?",
        )
        .get(session.session_id, i) as any;

      try {
        onProgress?.(
          `${bar(sessionNum, sessions.length)} ${sessionNum}/${sessions.length} ${session.project} session ${session.session_id}`,
        );
        const vec = await embed(chunk.text);
        const existing = hasVec.get(chunkRow.id);
        if (existing) {
          replaceVec.run(new Uint8Array(vec.buffer), chunkRow.id);
        } else {
          insertVec.run(chunkRow.id, new Uint8Array(vec.buffer));
        }
        embedded++;
        bytesEmbedded += chunk.text.length;
      } catch (e: any) {
        // ora v10: console output prints cleanly above the running spinner
        console.error(
          `✗ embed failed for ${session.session_id}[${i}]: ${e.message}`,
        );
      }
      i++;
    }

    console.log(`✓ ${i} chunks  ${session.project}  (${session.session_id})`);
    deleteOldChunks.run(session.session_id, i);
  }
  return embedded;
}

export async function sync(
  db: Database,
  opts: { rebuild?: boolean } = {},
): Promise<Result> {
  const configError = requireEmbedConfig();
  if (configError) return configError;

  const noStdin = { discardStdin: false };

  // Destructive: wipe the message index and re-ingest every transcript from
  // scratch. log and sync_state must be cleared together — clearing only
  // sync_state makes every file look new and duplicates all rows.
  if (opts.rebuild) {
    db.transaction(() => {
      db.run("DELETE FROM log");
      db.run("DELETE FROM sync_state");
    })();
  }

  const spin = ora({ ...noStdin, text: "Syncing messages…" }).start();
  const syncResult = syncLog(db, (s) => {
    spin.text = `Syncing messages… ${s}`;
  });
  const existing = syncResult.updatedSessions - syncResult.newSessions;
  spin.succeed(
    `${syncResult.messages} new messages. ${syncResult.newSessions} new sessions${existing ? `, ${existing} updated` : ""}`,
  );

  const serverOk = await fetch(`${EMBED_BASE_URL}/v1/models`, {
    headers: apiHeaders,
  })
    .then((r) => r.ok)
    .catch(() => false);
  if (!serverOk) {
    ora(noStdin).fail(`Cannot reach inference server at ${EMBED_BASE_URL}`);
  } else {
    const pending = db
      .prepare(`
      SELECT count(DISTINCT session_id) as n FROM (
        SELECT l.session_id
        FROM log l
        LEFT JOIN chunks c ON c.session_id = l.session_id
        WHERE l.text IS NOT NULL AND c.id IS NULL
          AND l.role IN ('user','assistant')
          AND (l.tools IS NULL OR l.tools = '[]')
        GROUP BY l.session_id
        HAVING sum(length(l.text)) >= ${Math.floor(MIN_CHUNK_TOKENS * 3.5)}
        UNION
        SELECT DISTINCT c.session_id
        FROM chunks c
        WHERE c.id NOT IN (SELECT rowid FROM chunks_vec)
      )
    `)
      .get() as any;
    const spin2 = ora({
      ...noStdin,
      text: `Syncing embeddings… 0/${pending.n} sessions`,
    }).start();
    const embCount = await syncChunks(db, (s) => {
      spin2.text = `Syncing embeddings… ${s}`;
    });
    spin2.succeed(`${embCount} chunks embedded`);
  }

  return ok(stats(db));
}
