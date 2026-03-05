import type { Database } from "bun:sqlite";
import { type Result, ok } from "../types.ts";

export async function list(db: Database): Promise<Result> {
  const results = db
    .prepare(`
    SELECT project, count(DISTINCT session_id) as sessions, count(*) as messages
    FROM log
    GROUP BY project
    ORDER BY sessions DESC
  `)
    .all() as any[];

  const lines = results.map(
    (r) => `${r.sessions} sessions\t${r.messages} msgs\t${r.project}`,
  );
  lines.push(`\n${results.length} projects`);
  return ok(lines.join("\n"));
}
