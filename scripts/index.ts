#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? join(process.env.CLAUDE_CONFIG_DIR, "claude")
  : join(homedir(), ".claude");
const HISTORY_FILE = join(CLAUDE_DIR, "history.jsonl");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const DB_PATH = join(CLAUDE_DIR, "claude.sqlite");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
const EMBED_DIM = 768;

// ── helpers ─────────────────────────────────────────────────────────

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

function extractTools(content: any): string | null {
  if (!Array.isArray(content)) return null;
  const tools = content
    .filter((c: any) => c.type === "tool_use")
    .map((c: any) => c.name);
  return tools.length ? JSON.stringify(tools) : null;
}

function tsToUnix(ts: any): number | null {
  if (ts == null) return null;
  if (typeof ts === "number") return ts;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function embed(text: string): Promise<Float32Array> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`ollama embed failed: ${res.status}`);
  const json = (await res.json()) as any;
  return new Float32Array(json.embeddings[0]);
}

// ── schema ──────────────────────────────────────────────────────────

function ensureSchema(db: Database) {
  db.exec("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      project     TEXT NOT NULL,
      display     TEXT,
      uuid        TEXT,
      parent_uuid TEXT,
      role        TEXT NOT NULL,
      text        TEXT,
      tools       TEXT,
      model       TEXT,
      timestamp   INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_log_session   ON log(session_id);
    CREATE INDEX IF NOT EXISTS idx_log_project   ON log(project);
    CREATE INDEX IF NOT EXISTS idx_log_timestamp ON log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_log_role      ON log(role);

    CREATE VIRTUAL TABLE IF NOT EXISTS log_fts USING fts5(
      text, content=log, content_rowid=id
    );

    -- triggers to keep fts in sync
    CREATE TRIGGER IF NOT EXISTS log_ai AFTER INSERT ON log BEGIN
      INSERT INTO log_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS log_ad AFTER DELETE ON log BEGIN
      INSERT INTO log_fts(log_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;

    CREATE TABLE IF NOT EXISTS chunks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL UNIQUE,
      project     TEXT NOT NULL,
      text        TEXT NOT NULL,
      hash        TEXT NOT NULL,
      ts_start    INTEGER,
      ts_end      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash    ON chunks(hash);

    -- track which jsonl files we've already ingested
    CREATE TABLE IF NOT EXISTS sync_state (
      file_path   TEXT PRIMARY KEY,
      mtime       INTEGER NOT NULL,
      size        INTEGER NOT NULL
    );
  `);

  db.run(
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${EMBED_DIM}])`
  );
}

// ── sync log table ──────────────────────────────────────────────────

function syncLog(db: Database) {
  // build session→project+display lookup from history.jsonl
  const sessionMeta = new Map<string, { project: string; display: string | null }>();
  const history = readJsonl(HISTORY_FILE);
  for (const entry of history) {
    if (!entry.sessionId || sessionMeta.has(entry.sessionId)) continue;
    sessionMeta.set(entry.sessionId, {
      project: entry.project ?? "",
      display: entry.display ?? null,
    });
  }

  const getSync = db.prepare("SELECT mtime, size FROM sync_state WHERE file_path = ?");
  const upsertSync = db.prepare(
    "INSERT OR REPLACE INTO sync_state (file_path, mtime, size) VALUES (?, ?, ?)"
  );
  const insertLog = db.prepare(`
    INSERT INTO log (session_id, project, display, uuid, parent_uuid, role, text, tools, model, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteBySession = db.prepare("DELETE FROM log WHERE session_id = ?");
  const countBySession = db.prepare("SELECT count(*) as n FROM log WHERE session_id = ?");

  if (!existsSync(PROJECTS_DIR)) return 0;

  let total = 0;
  const projectDirs = readdirSync(PROJECTS_DIR);

  for (const dir of projectDirs) {
    const dirPath = join(PROJECTS_DIR, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(dirPath, file);
      const stat = statSync(filePath);
      const mtime = Math.floor(stat.mtimeMs);
      const size = stat.size;

      // skip unchanged files
      const prev = getSync.get(filePath) as any;
      if (prev && prev.mtime === mtime && prev.size === size) continue;

      const sessionId = file.replace(/\.jsonl$/, "");
      const meta = sessionMeta.get(sessionId);
      const project = meta?.project ?? dir.replace(/^-/, "").replace(/-/g, "/");
      const display = meta?.display ?? null;

      const lines = readJsonl(filePath);

      const batch = db.transaction(() => {
        // re-ingest changed file, track previous count to report net new
        let prevCount = 0;
        if (prev) {
          prevCount = (countBySession.get(sessionId) as any).n;
          deleteBySession.run(sessionId);
        }

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
            tsToUnix(entry.timestamp)
          );
          inserted++;
        }
        total += inserted - prevCount;
        upsertSync.run(filePath, mtime, size);
      });
      batch();
    }
  }
  return total;
}

// ── sync chunks + embeddings ────────────────────────────────────────

async function syncChunks(db: Database) {
  // get all sessions that have log entries but no chunk (or stale chunk)
  const sessions = db
    .prepare(
      `SELECT l.session_id, l.project,
              min(l.timestamp) as ts_start, max(l.timestamp) as ts_end
       FROM log l
       LEFT JOIN chunks c ON c.session_id = l.session_id
       WHERE l.text IS NOT NULL
       GROUP BY l.session_id
       HAVING c.id IS NULL`
    )
    .all() as any[];

  if (!sessions.length) return 0;

  const getChunkTexts = db.prepare(
    `SELECT role, text FROM log
     WHERE session_id = ? AND text IS NOT NULL AND role IN ('user','assistant')
       AND (tools IS NULL OR tools = '[]')
     ORDER BY timestamp`
  );
  const insertChunk = db.prepare(
    `INSERT OR REPLACE INTO chunks (session_id, project, text, hash, ts_start, ts_end)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const hasVec = db.prepare("SELECT rowid FROM chunks_vec WHERE rowid = ?");
  const insertVec = db.prepare("INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)");
  const replaceVec = db.prepare("UPDATE chunks_vec SET embedding = ? WHERE rowid = ?");

  let embedded = 0;
  for (const session of sessions) {
    const rows = getChunkTexts.all(session.session_id) as any[];
    if (!rows.length) continue;

    // build conversation text: "user: ...\nassistant: ..."
    const conversation = rows
      .map((r) => {
        const trimmed = r.text.slice(0, 2000); // cap per-message to keep chunk reasonable
        return `${r.role}: ${trimmed}`;
      })
      .join("\n");

    // skip tiny conversations
    if (conversation.length < 50) continue;

    // cap total chunk size for embedding
    const chunk = conversation.slice(0, 8000);
    const hash = sha256(chunk);

    insertChunk.run(
      session.session_id,
      session.project,
      chunk,
      hash,
      session.ts_start,
      session.ts_end
    );

    // get the auto-assigned rowid
    const chunkRow = db
      .prepare("SELECT id FROM chunks WHERE session_id = ?")
      .get(session.session_id) as any;

    try {
      const vec = await embed(chunk);
      const existing = hasVec.get(chunkRow.id);
      if (existing) {
        replaceVec.run(new Uint8Array(vec.buffer), chunkRow.id);
      } else {
        insertVec.run(chunkRow.id, new Uint8Array(vec.buffer));
      }
      embedded++;
      if (embedded % 25 === 0) process.stdout.write(`  ${embedded} sessions embedded\r`);
    } catch (e: any) {
      console.error(`  embed failed for ${session.session_id}: ${e.message}`);
    }
  }
  return embedded;
}

// ── main ────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.loadExtension(sqliteVec.getLoadablePath());
ensureSchema(db);

console.log("Syncing messages...");
const msgCount = syncLog(db);
console.log(`  ${msgCount} new messages`);

console.log("Syncing embeddings...");
const embCount = await syncChunks(db);
console.log(`  ${embCount} sessions embedded`);

const totals = db.prepare("SELECT (SELECT count(*) FROM log) as msgs, (SELECT count(*) FROM chunks) as chunks").get() as any;
console.log(`Total: ${totals.msgs} messages, ${totals.chunks} chunks`);
console.log(`Written to ${DB_PATH}`);
db.close();
