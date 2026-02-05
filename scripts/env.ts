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
