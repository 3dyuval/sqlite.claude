#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { join } from "path";
import { homedir } from "os";

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? join(process.env.CLAUDE_CONFIG_DIR, "claude")
  : join(homedir(), ".claude");
const DB_PATH = join(CLAUDE_DIR, "claude.sqlite");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";

const usage = `Usage: bun search.ts <mode> <query> [options]

Modes:
  fts <query>        Full-text keyword search (FTS5 syntax: AND, OR, NOT, "phrase", prefix*)
  semantic <query>   Semantic similarity search via embeddings (requires ollama)

Options:
  --project <glob>   Filter by project path (GLOB pattern)
  --days <n>         Only search last N days
  --limit <n>        Max results (default: 10)
  --session <id>     Drill into a specific session's messages`;

// parse args
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log(usage);
  process.exit(1);
}

const mode = args[0]!;
const query = args[1]!;
let project: string | null = null;
let days: number | null = null;
let limit = 10;
let sessionId: string | null = null;

for (let i = 2; i < args.length; i++) {
  switch (args[i]) {
    case "--project": project = args[++i]!; break;
    case "--days": days = parseInt(args[++i]!, 10); break;
    case "--limit": limit = parseInt(args[++i]!, 10); break;
    case "--session": sessionId = args[++i]!; break;
  }
}

const db = new Database(DB_PATH);
db.loadExtension(sqliteVec.getLoadablePath());

// drill into session
if (sessionId) {
  const msgs = db.prepare(`
    SELECT role, substr(text, 1, 500) as text,
           datetime(timestamp/1000, 'unixepoch', 'localtime') as time
    FROM log WHERE session_id = ? AND text IS NOT NULL
    ORDER BY timestamp
  `).all(sessionId) as any[];
  for (const m of msgs) {
    console.log(`\n[${m.time}] ${m.role}:`);
    console.log(m.text);
  }
  db.close();
  process.exit(0);
}

// build WHERE clauses
const wheres: string[] = [];
const params: any[] = [];

if (project) {
  wheres.push("l.project GLOB ?");
  params.push(project);
}
if (days) {
  wheres.push("l.timestamp > (strftime('%s','now',?) * 1000)");
  params.push(`-${days} days`);
}

if (mode === "fts") {
  const where = wheres.length ? " AND " + wheres.join(" AND ") : "";
  const results = db.prepare(`
    SELECT l.session_id, l.project, l.role,
           substr(l.text, 1, 300) as preview,
           datetime(l.timestamp/1000, 'unixepoch', 'localtime') as time
    FROM log l
    JOIN log_fts ON log_fts.rowid = l.id
    WHERE log_fts MATCH ?${where}
    ORDER BY l.timestamp DESC
    LIMIT ?
  `).all(query, ...params, limit) as any[];

  for (const r of results) {
    console.log(`\n[${r.time}] ${r.role} (${r.project})`);
    console.log(`  session: ${r.session_id}`);
    console.log(`  ${r.preview.replace(/\n/g, " ").substring(0, 200)}`);
  }
  console.log(`\n${results.length} results`);

} else if (mode === "semantic") {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    body: JSON.stringify({ model: EMBED_MODEL, input: query }),
  });
  if (!resp.ok) {
    console.error(`ollama embed failed: ${resp.status}`);
    process.exit(1);
  }
  const json = await resp.json() as any;
  const queryVec = new Float32Array(json.embeddings[0]);

  // remap wheres to use chunks table alias
  const chunkWheres = wheres.map(w => w.replace("l.", "c.").replace("l.timestamp", "c.ts_end"));
  const where = chunkWheres.length ? " WHERE " + chunkWheres.join(" AND ") : "";

  const results = db.prepare(`
    SELECT c.session_id, c.project,
           datetime(c.ts_start/1000, 'unixepoch', 'localtime') as started,
           datetime(c.ts_end/1000, 'unixepoch', 'localtime') as ended,
           substr(c.text, 1, 300) as preview,
           vec_distance_cosine(v.embedding, ?) as distance
    FROM chunks_vec v
    JOIN chunks c ON c.id = v.rowid
    ${where}
    ORDER BY distance
    LIMIT ?
  `).all(new Uint8Array(queryVec.buffer), ...params, limit) as any[];

  for (const r of results) {
    console.log(`\n--- distance: ${r.distance.toFixed(4)} ---`);
    console.log(`  project: ${r.project}`);
    console.log(`  time: ${r.started} -> ${r.ended}`);
    console.log(`  session: ${r.session_id}`);
    console.log(`  ${r.preview.replace(/\n/g, " ").substring(0, 200)}`);
  }
  console.log(`\n${results.length} results`);

} else {
  console.error(`Unknown mode: ${mode}. Use 'fts' or 'semantic'.`);
  process.exit(1);
}

db.close();
