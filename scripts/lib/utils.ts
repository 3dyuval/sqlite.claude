import { createHash } from "crypto";
import { ollamaHeaders, OLLAMA_URL, EMBED_MODEL } from "./env.ts";

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

export async function embed(text: string): Promise<Float32Array> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: ollamaHeaders,
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`ollama embed failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as any;
  return new Float32Array(json.embeddings[0]);
}
