import type { Database } from "bun:sqlite";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import ora from "ora";
import {
  ollamaHeaders,
  OLLAMA_URL,
  EMBED_DIM,
  CHUNK_SIZE,
  HISTORY_FILE,
  PROJECTS_DIR,
} from "../env.ts";
import { chunkMessages } from "../chunks.ts";
import {
  extractText,
  extractTools,
  tsToUnix,
  fmtSize,
  sha256,
  embed,
} from "../utils.ts";
import { type Result, ok, envError, ollamaUnreachable } from "../types.ts";

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
    INSERT INTO log (session_id, project, display, uuid, parent_uuid, role, text, tools, model, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        SELECT DISTINCT l.session_id, l.project
        FROM log l
        LEFT JOIN chunks c ON c.session_id = l.session_id
        WHERE l.text IS NOT NULL AND c.id IS NULL
        UNION
        SELECT DISTINCT c.session_id, c.project
        FROM chunks c
        WHERE c.id NOT IN (SELECT rowid FROM chunks_vec)
      )`,
    )
    .all() as any[];

  console.debug("[syncChunks] found", sessions.length, "sessions needing chunks/vectors");
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
  for (const session of sessions) {
    const rows = getMessages.all(session.session_id) as any[];
    console.debug("[syncChunks] session", session.session_id, "rows:", rows.length);
    if (!rows.length) continue;

    let i = 0;
    for (const chunk of chunkMessages(rows, CHUNK_SIZE)) {
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
        console.debug("[syncChunks] embedding chunk", i, "len:", chunk.text.length);
        const vec = await embed(chunk.text);
        const existing = hasVec.get(chunkRow.id);
        if (existing) {
          replaceVec.run(new Uint8Array(vec.buffer), chunkRow.id);
        } else {
          insertVec.run(chunkRow.id, new Uint8Array(vec.buffer));
        }
        embedded++;
        bytesEmbedded += chunk.text.length;
        onProgress?.(
          `${embedded} chunks from ${sessions.length} sessions (${fmtSize(bytesEmbedded)})`,
        );
      } catch (e: any) {
        console.error(
          `  embed failed for ${session.session_id}[${i}]: ${e.message}`,
        );
      }
      i++;
    }

    console.debug("[syncChunks] session done, total chunks:", i);
    deleteOldChunks.run(session.session_id, i);
  }
  console.debug("[syncChunks] all done, embedded:", embedded);
  return embedded;
}

export async function sync(db: Database): Promise<Result> {
  const missing: string[] = [];
  if (!OLLAMA_URL) missing.push("OLLAMA_URL");
  if (!process.env.EMBED_MODEL) missing.push("EMBED_MODEL");
  if (!EMBED_DIM) missing.push("EMBED_DIM");
  if (missing.length) return envError(missing);

  const noStdin = { discardStdin: false };
  const lines: string[] = [];
  let lastProgress = "";

  const printStats = () => {
    const stats = db
      .prepare(`
      SELECT
        (SELECT count(*) FROM log) as messages,
        (SELECT count(DISTINCT session_id) FROM log) as sessions,
        (SELECT count(*) FROM chunks) as chunks,
        (SELECT count(*) FROM chunks_vec) as vectors
    `)
      .get() as any;
    const m = stats.chunks - stats.vectors;
    lines.push(
      `${stats.messages} messages, ${stats.sessions} sessions, ${stats.chunks} chunks, ${stats.vectors} vectors`,
    );
    if (m > 0)
      lines.push(`! ${m} chunks missing embeddings. Re-run with Ollama`);
  };

  printStats();

  const spin = ora({ ...noStdin, text: "Syncing messages…" }).start();
  const syncResult = syncLog(db, (s) => {
    spin.text = `Syncing messages… ${s}`;
  });
  const existing = syncResult.updatedSessions - syncResult.newSessions;
  spin.succeed(
    `${syncResult.messages} new messages. ${syncResult.newSessions} new sessions${existing ? `, ${existing} updated` : ""}`,
  );
  lines.push(
    `${syncResult.messages} new messages. ${syncResult.newSessions} new sessions${existing ? `, ${existing} updated` : ""}`,
  );

  console.debug("[sync] checking ollama at", OLLAMA_URL);
  const ollamaOk = await fetch(`${OLLAMA_URL}/api/tags`, {
    headers: ollamaHeaders,
  })
    .then(() => true)
    .catch(() => false);
  console.debug("[sync] ollama reachable:", ollamaOk);
  if (!ollamaOk) {
    ora(noStdin).fail(
      `Cannot reach Ollama at ${OLLAMA_URL}. Run: ollama serve`,
    );
    lines.push(`Cannot reach Ollama at ${OLLAMA_URL}. Run: ollama serve`);
  } else {
    console.debug("[sync] querying pending count...");
    const pending = db
      .prepare(`
      SELECT count(DISTINCT session_id) as n FROM (
        SELECT DISTINCT l.session_id
        FROM log l
        LEFT JOIN chunks c ON c.session_id = l.session_id
        WHERE l.text IS NOT NULL AND c.id IS NULL
        UNION
        SELECT DISTINCT c.session_id
        FROM chunks c
        WHERE c.id NOT IN (SELECT rowid FROM chunks_vec)
      )
    `)
      .get() as any;
    console.debug("[sync] pending sessions:", pending.n);
    const spin2 = ora({
      ...noStdin,
      text: `Syncing embeddings… 0/${pending.n} sessions`,
    }).start();
    const embCount = await syncChunks(db, (s) => {
      lastProgress = s;
      spin2.text = `Syncing embeddings… ${s}`;
    });
    console.debug("[sync] embedding done:", embCount);
    spin2.succeed(`${embCount} chunks embedded`);
    lines.push(`${embCount} chunks embedded`);
  }

  if (lastProgress) lines.push(lastProgress);
  printStats();
  lines.push(db.filename);

  return ok(lines.join("\n"));
}
