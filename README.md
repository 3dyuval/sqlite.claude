# sqlite.claude

Query and search Claude Code conversation history via a local SQLite database
with full-text search and vector embeddings. See [SKILL.md](./SKILL.md) for
usage, schema, and query patterns.

## TODO

### Cross-machine history (multi-host)

Today the DB is a single local file, authoritative only for the machine that
built it — so searches miss sessions from other machines.

**Approach: sync the source, not the DB.** The SQLite file is a derived cache;
the source of truth is the JSONL transcripts under `~/.config/claude/projects/`.
So don't replicate the `.sqlite` (live SQLite + WAL over a file-sync tool like
Syncthing/S3 risks corruption or last-writer-wins clobber). Instead:

- Sync the **JSONL transcripts** between machines (Syncthing fits — append-only,
  independent per-session files, trivial conflict surface).
- Each machine runs `sync` locally against the union of transcripts and builds
  its **own** local DB (stays single-writer, no corruption risk, disposable).
- Add a `host` / `machine-id` column so every `log`/`chunk` row records its
  origin machine.

**Work involved:**
- [ ] Add `host` column to `log` and `chunks` (+ index); backfill = re-sync.
- [ ] Teach `sync` to ingest a multi-host transcript tree and tag rows by host.
- [ ] Add `--host` filter to `search` / `list`, and a host column in `list`.
- [ ] Document the Syncthing-of-transcripts setup.

Rejected alternatives: multiple DBs (forces a federation/merge layer over FTS +
vectors), or syncing the live DB file (corruption / clobber). A central
networked DB (Postgres / remote SQLite) stays possible later but adds a server.
