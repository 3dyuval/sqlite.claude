---
name: sqlite.claude
description: This skill should be used when the user asks to "search conversation history", "find past sessions", "query claude logs", "what did I work on", "semantic search conversations", "find discussions about X", or needs to filter, analyze, or search Claude Code session history using SQLite. Also applies when the user mentions "claude.sqlite", "sync logs", or "embed conversations".
version: 0.1.0
---

# Claude Code SQLite Log

Query and search Claude Code conversation history via a denormalized SQLite database with full-text search and vector embeddings.

## Architecture

The system has three components:

1. **Sync script** (`<skill_base_dir>/scripts/index.ts`) — ingests JSONL transcripts into SQLite, append-only with mtime tracking
2. **Search CLI** (`<skill_base_dir>/scripts/search.ts`) — keyword and semantic search with filters
3. **SQLite database** (`~/.claude/claude.sqlite`) — the query target, three layers of access

### Database Location

Resolves via `$CLAUDE_CONFIG_DIR/claude/claude.sqlite`, falling back to `~/.claude/claude.sqlite`.

## Syncing

Before querying, ensure the database is up to date:

```bash
bun run <skill_base_dir>/scripts/index.ts
```

The sync is incremental — tracks file mtime/size in a `sync_state` table, only re-ingests changed transcript files. Embedding requires ollama running with `nomic-embed-text`.

Override defaults with env vars: `OLLAMA_URL`, `EMBED_MODEL`.

## Schema

### `log` table — denormalized flat messages

Every user/assistant message with session context inlined. No joins needed.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | autoincrement PK |
| `session_id` | TEXT | session UUID |
| `project` | TEXT | absolute project path (e.g. `/home/user/projects/myapp`) |
| `display` | TEXT | initial user prompt for the session |
| `uuid` | TEXT | message UUID |
| `parent_uuid` | TEXT | parent message UUID |
| `role` | TEXT | `user` or `assistant` |
| `text` | TEXT | extracted text content (tool_use blocks excluded) |
| `tools` | TEXT | JSON array of tool names used, or NULL |
| `model` | TEXT | model ID (assistant messages only) |
| `timestamp` | INTEGER | unix ms |

Indexes: `session_id`, `project`, `timestamp`, `role`.

### `log_fts` — FTS5 full-text index

Content-synced virtual table over `log.text`. Use for keyword search.

```sql
SELECT l.* FROM log l
JOIN log_fts ON log_fts.rowid = l.id
WHERE log_fts MATCH 'authentication AND jwt'
  AND l.project GLOB '/home/user/projects/*'
  AND l.timestamp > strftime('%s','now','-7 days') * 1000;
```

### `chunks` table — conversation summaries

One row per session. Concatenated user+assistant text (tool-only messages excluded), capped at 8000 chars.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | autoincrement PK, used as rowid in `chunks_vec` |
| `session_id` | TEXT | session UUID (UNIQUE) |
| `project` | TEXT | project path |
| `text` | TEXT | concatenated conversation text |
| `hash` | TEXT | sha256 of chunk text |
| `ts_start` | INTEGER | first message timestamp (unix ms) |
| `ts_end` | INTEGER | last message timestamp (unix ms) |

### `chunks_vec` — vector embeddings (sqlite-vec)

768-dim float vectors from `nomic-embed-text` via ollama. Rowid matches `chunks.id`.

## Query Patterns

### Filtering by project path

Use SQLite `GLOB` for path matching — it supports `*` and `**` style wildcards:

```sql
-- exact project
WHERE project = '/home/user/projects/myapp'

-- all subprojects under projects/
WHERE project GLOB '/home/user/projects/*'

-- all config-related projects
WHERE project GLOB '/home/user/.config/*'
```

### Filtering by time range

Timestamps are unix milliseconds. Convert relative dates:

```sql
-- last 7 days
WHERE timestamp > (strftime('%s','now','-7 days') * 1000)

-- last 30 days
WHERE timestamp > (strftime('%s','now','-30 days') * 1000)

-- specific range
WHERE timestamp BETWEEN 1706745600000 AND 1707350400000

-- human-readable in output
SELECT datetime(timestamp/1000, 'unixepoch', 'localtime') as time, ...
```

### Full-text search (CLI)

```bash
# keyword search
bun <skill_base_dir>/scripts/search.ts fts "typescript AND react"

# with filters
bun <skill_base_dir>/scripts/search.ts fts "authentication" --project "/home/user/projects/*" --days 30 --limit 20
```

FTS5 query syntax: `AND`, `OR`, `NOT`, phrase queries (`"exact phrase"`), prefix queries (`react*`).

### Semantic search (CLI)

Requires ollama running with `nomic-embed-text`.

```bash
# semantic similarity search
bun <skill_base_dir>/scripts/search.ts semantic "debugging memory leaks"

# with filters
bun <skill_base_dir>/scripts/search.ts semantic "browser automation testing" --project "/home/user/projects/*" --days 7
```

### Drill into a session

Use the `session_id` from search results to see full messages:

```bash
bun <skill_base_dir>/scripts/search.ts fts "" --session <session_id>
```

### Useful aggregate queries

```sql
-- sessions per project, sorted by activity
SELECT project, count(DISTINCT session_id) as sessions, count(*) as messages
FROM log GROUP BY project ORDER BY messages DESC;

-- tools usage frequency
SELECT json_each.value as tool, count(*) as uses
FROM log, json_each(log.tools)
WHERE tools IS NOT NULL
GROUP BY tool ORDER BY uses DESC;

-- daily message volume
SELECT date(timestamp/1000, 'unixepoch', 'localtime') as day, count(*) as msgs
FROM log GROUP BY day ORDER BY day DESC LIMIT 14;
```

## Workflow

1. Sync: `bun run <skill_base_dir>/scripts/index.ts`
2. Keyword search: `bun <skill_base_dir>/scripts/search.ts fts "<query>" [--project <glob>] [--days <n>] [--limit <n>]`
3. Semantic search: `bun <skill_base_dir>/scripts/search.ts semantic "<query>" [--project <glob>] [--days <n>] [--limit <n>]`
4. Drill into session: `bun <skill_base_dir>/scripts/search.ts fts "" --session <session_id>`
5. For complex/aggregate queries, use `sqlite3 ~/.claude/claude.sqlite` directly with the schema above
