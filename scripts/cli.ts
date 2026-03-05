#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { defineCommand, runMain } from "citty";
import { match } from "ts-pattern";
import {
  type Result, getDb,
  sync, recent, fts, semantic, dump, sql, list,
} from "./lib/index.ts";

const searchArgs = {
  project: {
    type: "string" as const,
    alias: "p",
    description: "Filter by project path (no value = cwd)",
  },
  days: {
    type: "string" as const,
    alias: "d",
    description: "Only search last N days",
  },
  limit: {
    type: "string" as const,
    alias: "l",
    description: "Max results (default 10)",
  },
  session: {
    type: "string" as const,
    alias: "s",
    description: "Drill into a specific session's messages",
  },
};

function parseOpts(args: {
  project?: string;
  days?: string;
  limit?: string;
  session?: string;
}) {
  return {
    project: args.project ?? null,
    days: args.days ? Number(args.days) : null,
    limit: args.limit ? Number(args.limit) : 10,
    session: args.session ?? null,
  };
}

function withDb(fn: (db: Database) => Promise<Result>): Promise<Result> {
  const dbOrErr = getDb();
  if (!(dbOrErr instanceof Database)) return Promise.resolve(dbOrErr);
  return fn(dbOrErr).finally(() => dbOrErr.close());
}

function handleResult(result: Result) {
  match(result)
    .with({ type: "ok" }, ({ data }) => {
      console.log(data);
    })
    .with({ type: "env-error" }, ({ missing }) => {
      console.error(`Missing env vars: ${missing.join(", ")}`);
      console.error("Set them in .env or pass --env-file=path/to/.env");
      process.exit(1);
    })
    .with({ type: "ollama-unreachable" }, ({ url }) => {
      console.error(`Cannot reach Ollama at ${url}. Run: ollama serve`);
      process.exit(1);
    })
    .with({ type: "db-error" }, ({ error }) => {
      console.error(`Database error: ${error}`);
      process.exit(1);
    })
    .with({ type: "no-command" }, () => {
      process.exit(1);
    })
    .exhaustive();
}

const main = defineCommand({
  meta: {
    name: "claude-sql",
    description: "Query your Claude Code conversation history",
  },
  subCommands: {
    sync: defineCommand({
      meta: {
        description: "Sync messages + embeddings from JSONL transcripts",
      },
      async run() {
        handleResult(await withDb((db) => sync(db)));
      },
    }),
    recent: defineCommand({
      meta: { description: "List recent sessions" },
      args: searchArgs,
      async run({ args }) {
        handleResult(await withDb((db) => recent(db, parseOpts(args))));
      },
    }),
    fts: defineCommand({
      meta: { description: "Keyword search (FTS5)" },
      args: {
        query: {
          type: "positional",
          description: "FTS5 search query",
          required: true,
        },
        ...searchArgs,
      },
      async run({ args }) {
        handleResult(
          await withDb((db) => fts(db, args.query, parseOpts(args))),
        );
      },
    }),
    semantic: defineCommand({
      meta: { description: "Similarity search (requires ollama)" },
      args: {
        query: {
          type: "positional",
          description: "Natural language search query",
          required: true,
        },
        ...searchArgs,
      },
      async run({ args }) {
        handleResult(
          await withDb((db) => semantic(db, args.query, parseOpts(args))),
        );
      },
    }),
    dump: defineCommand({
      meta: { description: "Output conversation text (pipe-friendly)" },
      args: searchArgs,
      async run({ args }) {
        handleResult(await withDb((db) => dump(db, parseOpts(args))));
      },
    }),
    sql: defineCommand({
      meta: { description: "Run raw SQL (sqlite-vec loaded)" },
      args: {
        query: {
          type: "positional",
          description: "SQL query to execute",
          required: true,
        },
      },
      async run({ args }) {
        handleResult(await withDb((db) => sql(db, args.query)));
      },
    }),
    list: defineCommand({
      meta: { description: "List all projects with session counts" },
      async run() {
        handleResult(await withDb((db) => list(db)));
      },
    }),
  },
});

runMain(main);
