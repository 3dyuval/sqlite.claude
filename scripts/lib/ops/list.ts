import type { Database } from "bun:sqlite";
import { type Result, type SearchOpts, ok } from "../types.ts";

export async function list(
  db: Database,
  opts: SearchOpts & { sessions?: boolean } = {},
): Promise<Result> {
  const { project, days, limit = 10, session, sessions } = opts;

  // drill into a single session's messages
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

  // session list (newest first), honoring --project / --days / --limit
  if (sessions) {
    const wheres: string[] = [];
    const params: any[] = [];
    if (project) {
      wheres.push("project GLOB ?");
      params.push(project);
    }
    if (days) {
      wheres.push("timestamp > (strftime('%s','now',?) * 1000)");
      params.push(`-${days} days`);
    }
    const where = wheres.length ? " WHERE " + wheres.join(" AND ") : "";
    const results = db
      .prepare(`
      SELECT session_id, project,
             count(*) as messages,
             date(min(timestamp)/1000, 'unixepoch', 'localtime') as created,
             datetime(max(timestamp)/1000, 'unixepoch', 'localtime') as last_message
      FROM log
      ${where}
      GROUP BY session_id
      ORDER BY max(timestamp) DESC
      LIMIT ?
    `)
      .all(...params, limit) as any[];

    const lines = results.map(
      (r) =>
        `${r.created}\t${r.last_message}\t${r.messages} msgs\t${r.project}\t${r.session_id}`,
    );
    lines.push(`\n${results.length} sessions`);
    return ok(lines.join("\n"));
  }

  // project summary (default)
  const results = db
    .prepare(`
    SELECT project,
           count(DISTINCT session_id) as sessions,
           count(*) as messages,
           date(min(timestamp)/1000, 'unixepoch', 'localtime') as created,
           datetime(max(timestamp)/1000, 'unixepoch', 'localtime') as last_message
    FROM log
    GROUP BY project
    ORDER BY max(timestamp) DESC
  `)
    .all() as any[];

  const lines = results.map(
    (r) =>
      `${r.created}\t${r.last_message}\t${r.sessions} sessions\t${r.messages} msgs\t${r.project}`,
  );
  lines.push(`\n${results.length} projects`);
  return ok(lines.join("\n"));
}
