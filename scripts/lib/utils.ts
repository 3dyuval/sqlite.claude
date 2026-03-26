import { createHash } from "crypto";
import { apiHeaders, EMBED_BASE_URL, EMBED_MODEL } from "./env.ts";

export function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

export function extractTools(content: any): string | null {
  if (!Array.isArray(content)) return null;
  const tools = content
    .filter((c: any) => c.type === "tool_use")
    .map((c: any) => c.name);
  return tools.length ? JSON.stringify(tools) : null;
}

export function tsToUnix(ts: any): number | null {
  if (ts == null) return null;
  if (typeof ts === "number") return ts;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d.getTime();
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function embedWithBudget(text: string, tokens: number): Promise<Float32Array> {
  const input = text.slice(0, Math.floor(tokens * 3.5));
  const res = await fetch(`${EMBED_BASE_URL}/v1/embeddings`, {
    method: "POST",
    headers: apiHeaders,
    body: JSON.stringify({ model: EMBED_MODEL, input }),
  });
  if (res.ok) {
    const json = (await res.json()) as any;
    return new Float32Array(json.data[0].embedding);
  }
  const body = await res.text();
  if (res.status === 500 && body.includes("too large") && tokens > 64)
    return embedWithBudget(text, tokens - 64);
  throw new Error(`embed failed: ${res.status} ${body}`);
}

// JSC (Bun) supports TCO so this tail-recurses properly, though async await limits the gain
export function embed(text: string, maxTokens = 512): Promise<Float32Array> {
  return embedWithBudget(text, maxTokens);
}
