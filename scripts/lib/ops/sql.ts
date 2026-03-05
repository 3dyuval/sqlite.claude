import type { Database } from "bun:sqlite";
import { type Result, ok } from "../types.ts";

export async function sql(db: Database, query: string): Promise<Result> {
  const rows = db.prepare(query).all() as any[];

  const lines = rows.map((row) => {
    const vals = Object.values(row);
    return vals.length === 1 ? String(vals[0]) : vals.join("\t");
  });
  return ok(lines.join("\n"));
}
