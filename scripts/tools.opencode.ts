import { tool } from "@opencode-ai/plugin";

const SCRIPT_DIR = import.meta.dir;
const run = async (args: string[]) => {
  const proc = Bun.spawn(["bun", `${SCRIPT_DIR}/cli.ts`, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return stderr ? `${stdout}\n${stderr}`.trim() : stdout.trim();
};

export const sync = tool({
  description: "Sync Claude Code conversation history into SQLite — ingests JSONL transcripts and embeds chunks for semantic search",
  args: {},
  async execute() {
    return await run(["sync"]);
  },
});

export const recent = tool({
  description: "List recent Claude Code sessions with timestamps, message counts, and initial prompts",
  args: {
    project: tool.schema.string().optional().describe("Filter by project path glob (e.g. '/home/user/proj/*')"),
    days: tool.schema.number().optional().describe("Only show sessions from the last N days"),
    limit: tool.schema.number().optional().describe("Max results (default 10)"),
  },
  async execute(args) {
    const flags: string[] = ["recent"];
    if (args.project) flags.push("--project", args.project);
    if (args.days) flags.push("--days", String(args.days));
    if (args.limit) flags.push("--limit", String(args.limit));
    return await run(flags);
  },
});

export const fts = tool({
  description: "Full-text keyword search across Claude Code conversation history. Uses FTS5 syntax: AND, OR, NOT, \"exact phrase\", prefix*",
  args: {
    query: tool.schema.string().describe("FTS5 search query (e.g. 'authentication AND jwt')"),
    project: tool.schema.string().optional().describe("Filter by project path glob"),
    days: tool.schema.number().optional().describe("Only search last N days"),
    limit: tool.schema.number().optional().describe("Max results (default 10)"),
    session: tool.schema.string().optional().describe("Drill into a specific session ID to see all messages"),
  },
  async execute(args) {
    const flags: string[] = ["fts", args.query];
    if (args.project) flags.push("--project", args.project);
    if (args.days) flags.push("--days", String(args.days));
    if (args.limit) flags.push("--limit", String(args.limit));
    if (args.session) flags.push("--session", args.session);
    return await run(flags);
  },
});

export const semantic = tool({
  description: "Semantic similarity search across Claude Code conversations using vector embeddings. Find discussions by meaning, not just keywords.",
  args: {
    query: tool.schema.string().describe("Natural language search query (e.g. 'debugging memory leaks')"),
    project: tool.schema.string().optional().describe("Filter by project path glob"),
    days: tool.schema.number().optional().describe("Only search last N days"),
    limit: tool.schema.number().optional().describe("Max results (default 10)"),
  },
  async execute(args) {
    const flags: string[] = ["semantic", args.query];
    if (args.project) flags.push("--project", args.project);
    if (args.days) flags.push("--days", String(args.days));
    if (args.limit) flags.push("--limit", String(args.limit));
    return await run(flags);
  },
});

export const dump = tool({
  description: "Dump raw conversation text from Claude Code sessions. Output is pipe-friendly for summarization or export.",
  args: {
    project: tool.schema.string().optional().describe("Filter by project path glob"),
    days: tool.schema.number().optional().describe("Only dump last N days"),
  },
  async execute(args) {
    const flags: string[] = ["dump"];
    if (args.project) flags.push("--project", args.project);
    if (args.days) flags.push("--days", String(args.days));
    return await run(flags);
  },
});

export const sql = tool({
  description: "Run a raw SQL query against the Claude Code SQLite database. Tables: log (messages), log_fts (full-text), chunks (conversation segments), chunks_vec (embeddings).",
  args: {
    query: tool.schema.string().describe("SQL query to execute"),
  },
  async execute(args) {
    return await run(["sql", args.query]);
  },
});

export const list = tool({
  description: "List all projects in the Claude Code conversation history with session and message counts",
  args: {},
  async execute() {
    return await run(["list"]);
  },
});
