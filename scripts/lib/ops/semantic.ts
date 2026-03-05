import type { Database } from "bun:sqlite";
import { ollamaHeaders, OLLAMA_URL, EMBED_MODEL } from "../env.ts";
import {
  type Result,
  type SearchOpts,
  ok,
  envError,
  ollamaUnreachable,
} from "../types.ts";

export async function semantic(
  db: Database,
  query: string,
  opts: SearchOpts,
): Promise<Result> {
  const missing: string[] = [];
  if (!OLLAMA_URL) missing.push("OLLAMA_URL");
  if (!EMBED_MODEL) missing.push("EMBED_MODEL");
  if (missing.length) return envError(missing);

  const { project, days, limit = 10 } = opts;

  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: ollamaHeaders,
    body: JSON.stringify({ model: EMBED_MODEL, input: query }),
  }).catch(() => null);

  if (!resp || !resp.ok) return ollamaUnreachable(OLLAMA_URL!);

  const json = (await resp.json()) as any;
  const queryVec = new Float32Array(json.embeddings[0]);

  const wheres: string[] = [];
  const params: any[] = [];

  if (project) {
    wheres.push("c.project GLOB ?");
    params.push(project);
  }
  if (days) {
    wheres.push("c.ts_end > (strftime('%s','now',?) * 1000)");
    params.push(`-${days} days`);
  }

  const where = wheres.length ? " WHERE " + wheres.join(" AND ") : "";
  const results = db
    .prepare(`
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
  `)
    .all(new Uint8Array(queryVec.buffer), ...params, limit) as any[];

  const lines: string[] = [];
  for (const r of results) {
    lines.push(`\n--- distance: ${r.distance.toFixed(4)} ---`);
    lines.push(`  project: ${r.project}`);
    lines.push(`  time: ${r.started} -> ${r.ended}`);
    lines.push(`  session: ${r.session_id}`);
    lines.push(`  ${r.preview.replace(/\n/g, " ").substring(0, 200)}`);
  }
  lines.push(`\n${results.length} results`);
  return ok(lines.join("\n"));
}
