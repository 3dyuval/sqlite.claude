import { join } from "path";
import { homedir } from "os";

// Load env files: system env > .env > default.env
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (m && m[1]) out[m[1]] = m[2];
  }
  return out;
}

const scriptsDir = join(import.meta.dir, "..");
const defaultEnv = parseEnvFile(await Bun.file(join(scriptsDir, "default.env")).text().catch(() => ""));
const userEnv = parseEnvFile(await Bun.file(join(scriptsDir, ".env")).text().catch(() => ""));

for (const [k, v] of Object.entries({ ...defaultEnv, ...userEnv })) {
  process.env[k] ??= v;
}

// AI_HEADERS=Key:Value,Key:Value — extra request headers (e.g. Cloudflare Access tokens)
export const apiHeaders: Record<string, string> = { "Content-Type": "application/json" };
const raw = process.env.AI_HEADERS ?? process.env.OLLAMA_HEADERS ?? "";
if (raw) {
  for (const pair of raw.split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) apiHeaders[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

// ── env vars ──────────────────────────────────────────────────────────
// EMBED_BASE_URL: any OpenAI-compat inference server (llama.cpp, Ollama, etc.)
export const EMBED_BASE_URL = process.env.EMBED_BASE_URL ?? process.env.OLLAMA_URL;
export const EMBED_MODEL = process.env.EMBED_MODEL;
export const EMBED_DIM = Number(process.env.EMBED_DIM || 768);
export const CHUNK_SIZE = Number(process.env.CHUNK_SIZE);
export const MIN_CHUNK_TOKENS = Number(process.env.MIN_CHUNK_TOKENS);

// ── paths ─────────────────────────────────────────────────────────────
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ?? join(homedir(), ".config", "claude");
export const HISTORY_FILE = join(CLAUDE_DIR, "history.jsonl");
export const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
export const DB_PATH = process.env.DB_PATH ?? join(import.meta.dir, "..", "claude.sqlite");
