import type { Database } from "bun:sqlite";
import { type Result, type SearchOpts, ok } from "../types.ts";

export async function recent(db: Database, opts: SearchOpts): Promise<Result> {
  const { project, days, limit = 10, session } = opts;

  if (session) {
    const msgs = db.prepare(`
      SELECT role, substr(text, 1, 500) as text,
             datetime(timestamp/1000, 'unixepoch', 'localtime') as time
      FROM log WHERE session_id = ? AND text IS NOT NULL
      ORDER BY timestamp
    `).all(session) as any[];
    const lines = msgs.map(m => `\n[${m.time}] ${m.role}:\n${m.text}`);
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

  const lines: string[] = [];
  for (const r of results) {
    lines.push(`\n${r.started} -> ${r.ended}  (${r.messages} msgs)`);
    lines.push(`  project: ${r.project}`);
    lines.push(`  session: ${r.session_id}`);
    if (r.display) lines.push(`  prompt:  ${r.display.replace(/\n/g, " ").substring(0, 120)}`);
  }
  lines.push(`\n${results.length} sessions`);
  return ok(lines.join("\n"));
}
