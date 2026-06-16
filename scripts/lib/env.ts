import { join, delimiter } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { type Result, envError } from "./types.ts";

const builtinDir = join(import.meta.dir, "..", "config");
const xdgConfig = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "claude-sql");
const userDir = process.env.SQLITE_CLAUDE_CONFIG_DIR
  ?? (existsSync(xdgConfig) ? xdgConfig : builtinDir);

process.env.NODE_CONFIG_DIR = [...new Set([builtinDir, userDir])].join(delimiter);
process.env.SUPPRESS_NO_CONFIG_WARNING = "true";

const { default: config } = await import("config");

type Get = <T>(key: string) => T | undefined;

const get: Get = (key) => (config.has(key) ? config.get(key) : undefined);

export const EMBED_BASE_URL = get<string>("embedBaseUrl");
export const EMBED_MODEL = get<string>("embedModel");
export const EMBED_DIM = Number(get<number | string>("embedDim") ?? 768);
export const CHUNK_SIZE = Number(get<number | string>("chunkSize") ?? 1000);
export const MIN_CHUNK_TOKENS = Number(get<number | string>("minChunkTokens") ?? 100);

export const CLAUDE_DIR = get<string>("claudeDir")!;
export const HISTORY_FILE = get<string>("historyFile")!;
export const PROJECTS_DIR = get<string>("projectsDir")!;

export const DATA_DIR = get<string>("dataDir")!;
export const DB_PATH = get<string>("dbPath")!;

export const apiHeaders: Record<string, string> = { "Content-Type": "application/json" };
const raw = get<string>("aiHeaders") ?? "";
for (const pair of raw.split(",")) {
  const i = pair.indexOf(":");
  if (i > 0) apiHeaders[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
}

export function requireEmbedConfig(): Result | null {
  const missing: string[] = [];
  if (!EMBED_BASE_URL) missing.push("EMBED_BASE_URL");
  if (!EMBED_MODEL) missing.push("EMBED_MODEL");
  return missing.length ? envError(missing) : null;
}
