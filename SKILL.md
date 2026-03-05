---
name: sqlite.claude
description: This skill should be used when the user asks to "search conversation history", "find past sessions", "query claude logs", "what did I work on", "semantic search conversations", "find discussions about X", or needs to filter, analyze, or search Claude Code session history using SQLite. Also applies when the user mentions "claude.sqlite", "sync logs", or "embed conversations".
version: 0.2.0
---

# Claude Code SQLite Log

Query and search Claude Code conversation history via a denormalized SQLite database with full-text search and vector embeddings.

## Install

```bash
cd <skill_base_dir>/scripts
bun install
bun link    # installs `claude-sql` globally
```

## CLI

All commands are available via `claude-sql`:

```bash
claude-sql sync                  # ingest transcripts + embed chunks
claude-sql dump [--project] [--days <n>]
claude-sql recent [--project] [--days <n>] [--limit <n>]
claude-sql fts "<query>" [--project <glob>] [--days <n>]
claude-sql semantic "<query>" [--project <glob>] [--days <n>]
claude-sql sql "<query>"
```

## Architecture

1. **Sync** (`claude-sql sync`) — ingests JSONL transcripts into SQLite, append-only with mtime tracking
2. **Search** (`claude-sql <command>`) — keyword and semantic search with filters
3. **SQLite database** (`~/.claude/claude.sqlite`) — three layers: messages, FTS, vectors

### Database Location

Resolves via `$CLAUDE_CONFIG_DIR/claude/claude.sqlite`, falling back to `~/.claude/claude.sqlite`.

## Configuration

Set in `<skill_base_dir>/.env` (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_HEADERS` | _(empty)_ | Extra headers as `Key:Value,Key:Value` (e.g. CF Access tokens) |
| `EMBED_MODEL` | `nomic-embed-text` | Embedding model name |
| `EMBED_DIM` | `768` | Embedding dimension |
| `CHUNK_SIZE` | `1000` | Max chars per chunk (smaller = more precise search) |

## Schema

### `log` table — denormalized flat messages

Every user/assistant message with session context inlined. No joins needed.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | autoincrement PK |
| `session_id` | TEXT | session UUID |
| `project` | TEXT | absolute project path |
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

### `chunks` table — conversation segments

Multiple chunks per session. Each chunk is a segment of the conversation (~`CHUNK_SIZE` chars), with its own timestamp range from the messages it contains.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | autoincrement PK, used as rowid in `chunks_vec` |
| `session_id` | TEXT | session UUID |
| `chunk_index` | INTEGER | position within session (0-based) |
| `project` | TEXT | project path |
| `text` | TEXT | conversation segment text |
| `hash` | TEXT | sha256 of chunk text |
| `ts_start` | INTEGER | first message timestamp in this chunk (unix ms) |
| `ts_end` | INTEGER | last message timestamp in this chunk (unix ms) |

UNIQUE constraint on `(session_id, chunk_index)`.

### `chunks_vec` — vector embeddings (sqlite-vec)

768-dim float vectors from `nomic-embed-text` via Ollama. Rowid matches `chunks.id`.

## Query Patterns

### Filtering by project path

```sql
WHERE project = '/home/user/projects/myapp'
WHERE project GLOB '/home/user/projects/*'
```

### Filtering by time range

Timestamps are unix milliseconds:

```sql
WHERE timestamp > (strftime('%s','now','-7 days') * 1000)
SELECT datetime(timestamp/1000, 'unixepoch', 'localtime') as time, ...
```

### Drill into a session

```bash
claude-sql fts "" --session <session_id>
```

### Useful aggregate queries

```sql
-- sessions per project
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
