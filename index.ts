#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { readFileSync, existsSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? join(process.env.CLAUDE_CONFIG_DIR, "claude")
  : join(homedir(), ".claude");
const HISTORY_FILE = join(CLAUDE_DIR, "history.jsonl");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const DB_PATH = join(CLAUDE_DIR, "claude.sqlite");

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

// ── main ────────────────────────────────────────────────────────────

if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE sessions (
    session_id  TEXT PRIMARY KEY,
    project     TEXT NOT NULL,
    timestamp   INTEGER,
    display     TEXT
  );

  CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    uuid        TEXT,
    parent_uuid TEXT,
    role        TEXT NOT NULL,
    text        TEXT,
    tools       TEXT,
    model       TEXT,
    timestamp   INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );

  CREATE INDEX idx_messages_session ON messages(session_id);
  CREATE INDEX idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX idx_sessions_project ON sessions(project);
`);

const insertSession = db.prepare(
  `INSERT OR IGNORE INTO sessions (session_id, project, timestamp, display) VALUES (?, ?, ?, ?)`
);

const insertMessage = db.prepare(
  `INSERT INTO messages (session_id, uuid, parent_uuid, role, text, tools, model, timestamp)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

// ── load history index ──────────────────────────────────────────────

console.log("Reading history index...");
const history = readJsonl(HISTORY_FILE);

const seen = new Set<string>();
const insertSessions = db.transaction(() => {
  for (const entry of history) {
    if (!entry.sessionId || seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);
    insertSession.run(
      entry.sessionId,
      entry.project ?? "",
      tsToUnix(entry.timestamp),
      entry.display ?? null
    );
  }
});
insertSessions();
console.log(`  ${seen.size} sessions indexed`);

// ── load transcripts ────────────────────────────────────────────────

console.log("Reading transcripts...");
let totalMessages = 0;

if (existsSync(PROJECTS_DIR)) {
  const projectDirs = readdirSync(PROJECTS_DIR);

  for (const dir of projectDirs) {
    const projectPath = join(PROJECTS_DIR, dir);
    let files: string[];
    try {
      files = readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(/\.jsonl$/, "");
      const filePath = join(projectPath, file);
      const lines = readJsonl(filePath);

      const projectName = dir.replace(/^-/, "").replace(/-/g, "/");
      insertSession.run(sessionId, projectName, null, null);

      const batch = db.transaction(() => {
        for (const entry of lines) {
          if (entry.type !== "user" && entry.type !== "assistant") continue;

          const text = extractText(entry.message?.content);
          const tools = extractTools(entry.message?.content);
          const model = entry.message?.model ?? null;
          const ts = tsToUnix(entry.timestamp);

          insertMessage.run(
            entry.sessionId ?? sessionId,
            entry.uuid ?? null,
            entry.parentUuid ?? null,
            entry.type,
            text || null,
            tools,
            model,
            ts
          );
          totalMessages++;
        }
      });
      batch();
    }
  }
}

console.log(`  ${totalMessages} messages loaded`);
console.log(`Written to ${DB_PATH}`);
db.close();
