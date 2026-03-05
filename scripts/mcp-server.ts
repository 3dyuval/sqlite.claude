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

const server = new McpServer({
  name: "claude-sql",
  version: "0.2.0",
});

const projectArg = z.string().optional().describe("Filter by project path glob (e.g. '/home/user/proj/*')");
const daysArg = z.number().optional().describe("Only search last N days");
const limitArg = z.number().optional().describe("Max results (default 10)");

server.tool(
  "sync",
  "Sync Claude Code conversation history into SQLite — ingests JSONL transcripts and embeds chunks for semantic search",
  {},
  async () => ({ content: [{ type: "text", text: await run(["sync"]) }] }),
);

server.tool(
  "recent",
  "List recent Claude Code sessions with timestamps, message counts, and initial prompts",
  { project: projectArg, days: daysArg, limit: limitArg },
  async ({ project, days, limit }) => {
    const flags: string[] = ["recent"];
    if (project) flags.push("--project", project);
    if (days) flags.push("--days", String(days));
    if (limit) flags.push("--limit", String(limit));
    return { content: [{ type: "text", text: await run(flags) }] };
  },
);

server.tool(
  "fts",
  "Full-text keyword search across Claude Code conversation history. Uses FTS5 syntax: AND, OR, NOT, \"exact phrase\", prefix*",
  {
    query: z.string().describe("FTS5 search query (e.g. 'authentication AND jwt')"),
    project: projectArg,
    days: daysArg,
    limit: limitArg,
    session: z.string().optional().describe("Drill into a specific session ID to see all messages"),
  },
  async ({ query, project, days, limit, session }) => {
    const flags: string[] = ["fts", query];
    if (project) flags.push("--project", project);
    if (days) flags.push("--days", String(days));
    if (limit) flags.push("--limit", String(limit));
    if (session) flags.push("--session", session);
    return { content: [{ type: "text", text: await run(flags) }] };
  },
);

server.tool(
  "semantic",
  "Semantic similarity search across Claude Code conversations using vector embeddings. Find discussions by meaning, not just keywords.",
  {
    query: z.string().describe("Natural language search query (e.g. 'debugging memory leaks')"),
    project: projectArg,
    days: daysArg,
    limit: limitArg,
  },
  async ({ query, project, days, limit }) => {
    const flags: string[] = ["semantic", query];
    if (project) flags.push("--project", project);
    if (days) flags.push("--days", String(days));
    if (limit) flags.push("--limit", String(limit));
    return { content: [{ type: "text", text: await run(flags) }] };
  },
);

server.tool(
  "dump",
  "Dump raw conversation text from Claude Code sessions. Output is pipe-friendly for summarization or export.",
  { project: projectArg, days: daysArg },
  async ({ project, days }) => {
    const flags: string[] = ["dump"];
    if (project) flags.push("--project", project);
    if (days) flags.push("--days", String(days));
    return { content: [{ type: "text", text: await run(flags) }] };
  },
);

server.tool(
  "sql",
  "Run a raw SQL query against the Claude Code SQLite database. Tables: log (messages), log_fts (full-text), chunks (conversation segments), chunks_vec (embeddings).",
  { query: z.string().describe("SQL query to execute") },
  async ({ query }) => ({ content: [{ type: "text", text: await run(["sql", query]) }] }),
);

server.tool(
  "list",
  "List all projects in the Claude Code conversation history with session and message counts",
  {},
  async () => ({ content: [{ type: "text", text: await run(["list"]) }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
