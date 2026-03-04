import { join } from "path";

// Bun auto-loads .env from cwd. When invoked from a different directory,
// we need to load it ourselves from the project root.
const envPath = join(import.meta.dir, "..", ".env");
const file = Bun.file(envPath);
if (await file.exists()) {
  for (const line of (await file.text()).split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}

// Parse OLLAMA_HEADERS=Key:Value,Key:Value into a headers object
export const ollamaHeaders: Record<string, string> = {};
const raw = process.env.OLLAMA_HEADERS ?? "";
if (raw) {
  for (const pair of raw.split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) ollamaHeaders[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
