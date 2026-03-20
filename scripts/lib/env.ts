import { join } from "path";
import { homedir } from "os";

// Parse OLLAMA_HEADERS=Key:Value,Key:Value into a headers object
export const ollamaHeaders: Record<string, string> = { "Content-Type": "application/json" };
const raw = process.env.OLLAMA_HEADERS ?? "";
if (raw) {
  for (const pair of raw.split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) ollamaHeaders[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

// ── env vars ──────────────────────────────────────────────────────────
export const OLLAMA_URL = process.env.OLLAMA_URL;
export const EMBED_MODEL = process.env.EMBED_MODEL;
export const EMBED_DIM = Number(process.env.EMBED_DIM || 768);
export const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 1000);

// ── paths ─────────────────────────────────────────────────────────────
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? join(process.env.CLAUDE_CONFIG_DIR, "claude")
  : join(homedir(), ".config", "claude");
export const HISTORY_FILE = join(CLAUDE_DIR, "history.jsonl");
export const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
export const DB_PATH = process.env.DB_PATH ?? join(import.meta.dir, "..", "claude.sqlite");
