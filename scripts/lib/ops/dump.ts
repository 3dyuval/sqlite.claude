import type { Database } from "bun:sqlite";
import { type Result, type SearchOpts, ok } from "../types.ts";

export async function dump(db: Database, opts: SearchOpts): Promise<Result> {
  const { project, days } = opts;

  const wheres: string[] = ["l.text IS NOT NULL"];
  const params: any[] = [];

  if (project) {
    wheres.push("l.project GLOB ?");
    params.push(project);
  }
  if (days) {
    wheres.push("l.timestamp > (strftime('%s','now',?) * 1000)");
    params.push(`-${days} days`);
  }

  const where = " WHERE " + wheres.join(" AND ");
  const rows = db
    .prepare(`
    SELECT l.role, l.text
    FROM log l
    ${where}
    ORDER BY l.timestamp
  `)
    .all(...params) as any[];

  const lines = rows.map((r) => `${r.role}: ${r.text}`);
  return ok(lines.join("\n"));
}
