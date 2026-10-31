import type { Database } from "bun:sqlite";
import { type Result, ok } from "../types.ts";

export async function list(db: Database): Promise<Result> {
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
