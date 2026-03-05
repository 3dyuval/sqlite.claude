import type { Database } from "bun:sqlite";
import { type Result, type SearchOpts, ok } from "../types.ts";

export async function fts(
  db: Database,
  query: string,
  opts: SearchOpts,
): Promise<Result> {
  const { project, days, limit = 10, session } = opts;

  if (session) {
    const msgs = db
      .prepare(`
      SELECT role, substr(text, 1, 500) as text,
             datetime(timestamp/1000, 'unixepoch', 'localtime') as time
      FROM log WHERE session_id = ? AND text IS NOT NULL
      ORDER BY timestamp
    `)
      .all(session) as any[];
    const lines = msgs.map((m) => `\n[${m.time}] ${m.role}:\n${m.text}`);
    return ok(lines.join(""));
  }

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

  const where = wheres.length ? " AND " + wheres.join(" AND ") : "";
  const results = db
    .prepare(`
    SELECT l.session_id, l.project, l.role,
           substr(l.text, 1, 300) as preview,
           datetime(l.timestamp/1000, 'unixepoch', 'localtime') as time
    FROM log l
    JOIN log_fts ON log_fts.rowid = l.id
    WHERE log_fts MATCH ?${where}
    ORDER BY l.timestamp DESC
    LIMIT ?
  `)
    .all(query, ...params, limit) as any[];

  const lines: string[] = [];
  for (const r of results) {
    lines.push(`\n[${r.time}] ${r.role} (${r.project})`);
    lines.push(`  session: ${r.session_id}`);
    lines.push(`  ${r.preview.replace(/\n/g, " ").substring(0, 200)}`);
  }
  lines.push(`\n${results.length} results`);
  return ok(lines.join("\n"));
}
