#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { join } from "path";
import { homedir } from "os";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import "./env.ts";

const OLLAMA_URL = process.env.OLLAMA_URL;
const EMBED_MODEL = process.env.EMBED_MODEL;

if (!OLLAMA_URL || !EMBED_MODEL) {
  console.error("Missing required env vars: OLLAMA_URL, EMBED_MODEL");
  console.error("Set them in .env at project root or pass --env-file=path/to/.env");
  process.exit(1);
}

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? join(process.env.CLAUDE_CONFIG_DIR, "claude")
  : join(homedir(), ".claude");
const DB_PATH = join(CLAUDE_DIR, "claude.sqlite");

// ── yargs CLI ────────────────────────────────────────────────────────

const sharedOpts = {
  project: {
    alias: "p",
    type: "string" as const,
    description: "Filter by project path (no value = cwd)",
  },
  days: {
    alias: "d",
    type: "number" as const,
    description: "Only search last N days",
  },
  limit: {
    alias: "l",
    type: "number" as const,
    default: 10,
    description: "Max results",
  },
  session: {
    alias: "s",
    type: "string" as const,
    description: "Drill into a specific session's messages",
  },
};

const argv = await yargs(hideBin(process.argv))
  .scriptName("search")
  .usage("sqlite.claude search — query your Claude Code conversation history")
  .command("dump", "Output conversation text (pipe-friendly)", sharedOpts)
  .command("recent", "List recent sessions", sharedOpts)
  .command("fts <query>", "Keyword search (FTS5)", sharedOpts)
  .command("semantic <query>", "Similarity search (requires ollama)", sharedOpts)
  .command("sql <query>", "Run raw SQL (sqlite-vec loaded)")
  .demandCommand(1, "Please specify a command: dump, recent, fts, semantic, sql")
  .completion()
  .example("dump --project --days 1", "Dump recent project conversations")
  .example('fts "authentication AND jwt"', "Full-text keyword search")
  .example('semantic "how to debug memory leaks" --limit 5', "Similarity search")
  .strict()
  .help()
  .parse();

const mode = String(argv._[0]);
const query = String(argv.query ?? "");
const project: string | null = argv.project === true || argv.project === "" ? process.cwd() : (argv.project as string | undefined) ?? null;
const days: number | null = (argv.days as number | undefined) ?? null;
const limit: number = (argv.limit as number | undefined) ?? 10;
const sessionId: string | null = (argv.session as string | undefined) ?? null;

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

if (mode === "dump") {
  const clauses = ["l.text IS NOT NULL", ...wheres];
  const where = " WHERE " + clauses.join(" AND ");
  const rows = db.prepare(`
    SELECT l.role, l.text
    FROM log l
    ${where}
    ORDER BY l.timestamp
  `).all(...params) as any[];

  for (const r of rows) {
    console.log(`${r.role}: ${r.text}`);
  }

} else if (mode === "recent") {
  const where = wheres.length ? " WHERE " + wheres.join(" AND ") : "";
  const results = db.prepare(`
    SELECT l.session_id, l.project, l.display,
           count(*) as messages,
           datetime(min(l.timestamp)/1000, 'unixepoch', 'localtime') as started,
           datetime(max(l.timestamp)/1000, 'unixepoch', 'localtime') as ended
    FROM log l
    ${where}
    GROUP BY l.session_id
    ORDER BY max(l.timestamp) DESC
    LIMIT ?
  `).all(...params, limit) as any[];

  for (const r of results) {
    console.log(`\n${r.started} -> ${r.ended}  (${r.messages} msgs)`);
    console.log(`  project: ${r.project}`);
    console.log(`  session: ${r.session_id}`);
    if (r.display) console.log(`  prompt:  ${r.display.replace(/\n/g, " ").substring(0, 120)}`);
  }
  console.log(`\n${results.length} sessions`);

} else if (mode === "fts") {
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

} else if (mode === "sql") {
  if (!query) {
    console.error("sql mode requires a query argument");
    process.exit(1);
  }
  const rows = db.prepare(query).all() as any[];
  for (const row of rows) {
    const vals = Object.values(row);
    console.log(vals.length === 1 ? vals[0] : vals.join("\t"));
  }

} else {
  console.error(`Unknown mode: ${mode}. Use 'recent', 'fts', 'semantic', or 'sql'.`);
  process.exit(1);
}

db.close();
