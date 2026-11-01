#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const server = new McpServer({
  name: "claude-sql",
  version: "0.2.0",
});

const projectArg = z
  .string()
  .optional()
  .describe("Filter by project path glob (e.g. '/home/user/proj/*')");
const daysArg = z.number().optional().describe("Only search last N days");
const limitArg = z.number().optional().describe("Max results (default 10)");

server.registerTool(
  "sync",
  {
    description:
      "Sync Claude Code conversation history into SQLite — ingests JSONL transcripts and embeds chunks for semantic search",
    inputSchema: z.object({}),
  },
  async () => text(await run(["sync"])),
);

server.registerTool(
  "search",
  {
    description:
      "Search Claude Code conversation history. Keyword (FTS5: AND, OR, NOT, \"exact phrase\", prefix*) by default; set semantic=true for vector similarity search by meaning.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      semantic: z
        .boolean()
        .optional()
        .describe("Similarity search via embeddings instead of keyword"),
      project: projectArg,
      days: daysArg,
      limit: limitArg,
      session: z
        .string()
        .optional()
        .describe("Drill into a specific session ID to see all messages"),
    }),
  },
  async ({ query, semantic, project, days, limit, session }) => {
    const flags: string[] = ["search", query];
    if (semantic) flags.push("--semantic");
    if (project) flags.push("--project", project);
    if (days) flags.push("--days", String(days));
    if (limit) flags.push("--limit", String(limit));
    if (session) flags.push("--session", session);
    return text(await run(flags));
  },
);

server.registerTool(
  "dump",
  {
    description:
      "Dump raw conversation text from Claude Code sessions. Output is pipe-friendly for summarization or export.",
    inputSchema: z.object({ project: projectArg, days: daysArg }),
  },
  async ({ project, days }) => {
    const flags: string[] = ["dump"];
    if (project) flags.push("--project", project);
    if (days) flags.push("--days", String(days));
    return text(await run(flags));
  },
);

server.registerTool(
  "sql",
  {
    description:
      "Run a raw SQL query against the Claude Code SQLite database. Tables: log (messages), log_fts (full-text), chunks (conversation segments), chunks_vec (embeddings).",
    inputSchema: z.object({ query: z.string().describe("SQL query to execute") }),
  },
  async ({ query }) => text(await run(["sql", query])),
);

server.registerTool(
  "list",
  {
    description:
      "List Claude Code history. Projects with session/message counts by default; sessions=true lists sessions newest-first; session=<id> shows one session's messages.",
    inputSchema: z.object({
      sessions: z
        .boolean()
        .optional()
        .describe("List sessions instead of projects"),
      session: z
        .string()
        .optional()
        .describe("Show messages for a specific session ID"),
      project: projectArg,
      days: daysArg,
      limit: limitArg,
    }),
  },
  async ({ sessions, session, project, days, limit }) => {
    const flags: string[] = ["list"];
    if (sessions) flags.push("--sessions");
    if (session) flags.push("--session", session);
    if (project) flags.push("--project", project);
    if (days) flags.push("--days", String(days));
    if (limit) flags.push("--limit", String(limit));
    return text(await run(flags));
  },
);

server.registerTool(
  "health",
  {
    description:
      "Show database stats (message/session/chunk/vector counts), the DB path, and the resolved config.",
    inputSchema: z.object({}),
  },
  async () => text(await run(["health"])),
);

const transport = new StdioServerTransport();
await server.connect(transport);
