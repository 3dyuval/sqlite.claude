import type { Database } from "bun:sqlite";
import { CONFIG } from "../env.ts";
import { type Result, ok } from "../types.ts";

/** Concise DB summary + path. Used for the tail of `sync`. */
export function stats(db: Database): string {
  const s = db
    .prepare(`
    SELECT
      (SELECT count(*) FROM log) as messages,
      (SELECT count(DISTINCT session_id) FROM log) as sessions,
      (SELECT count(*) FROM chunks) as chunks,
      (SELECT count(*) FROM chunks_vec) as vectors
  `)
    .get() as any;

  const lines = [
    `${s.messages} messages, ${s.sessions} sessions, ${s.chunks} chunks, ${s.vectors} vectors`,
  ];
  const missing = s.chunks - s.vectors;
  if (missing > 0)
    lines.push(
      `! ${missing} chunks missing embeddings. Re-run with inference server running`,
    );
  lines.push(`db: ${db.filename}`);
  return lines.join("\n");
}

/** stats + the resolved config, as-is. The `health` command. */
export function health(db: Database): Result {
  return ok(`${stats(db)}\n${JSON.stringify(CONFIG, null, 2)}`);
}
