import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { EMBED_DIM, DB_PATH } from "./env.ts";
import { type Result, dbError } from "./types.ts";

function ensureSchema(db: Database) {
  db.run("PRAGMA journal_mode = WAL");

  db.run(`
    CREATE TABLE IF NOT EXISTS log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      project     TEXT NOT NULL,
      display     TEXT,
      uuid        TEXT,
      parent_uuid TEXT,
      role        TEXT NOT NULL,
      text        TEXT,
      tools       TEXT,
      model       TEXT,
      timestamp   INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_log_session   ON log(session_id);
    CREATE INDEX IF NOT EXISTS idx_log_project   ON log(project);
    CREATE INDEX IF NOT EXISTS idx_log_timestamp ON log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_log_role      ON log(role);

    CREATE VIRTUAL TABLE IF NOT EXISTS log_fts USING fts5(
      text, content=log, content_rowid=id
    );

    -- triggers to keep fts in sync
    CREATE TRIGGER IF NOT EXISTS log_ai AFTER INSERT ON log BEGIN
      INSERT INTO log_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS log_ad AFTER DELETE ON log BEGIN
      INSERT INTO log_fts(log_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;

    CREATE TABLE IF NOT EXISTS chunks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      project     TEXT NOT NULL,
      text        TEXT NOT NULL,
      hash        TEXT NOT NULL,
      ts_start    INTEGER,
      ts_end      INTEGER,
      UNIQUE(session_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash    ON chunks(hash);
    CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);

    -- track which jsonl files we've already ingested
    CREATE TABLE IF NOT EXISTS sync_state (
      file_path   TEXT PRIMARY KEY,
      mtime       INTEGER NOT NULL,
      size        INTEGER NOT NULL
    );
  `);

  db.run(
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${EMBED_DIM}])`
  );
}

export function getDb(): Database | Result {
  try {
    const db = new Database(DB_PATH);
    db.loadExtension(sqliteVec.getLoadablePath());
    ensureSchema(db);
    return db;
  } catch (e: any) {
    return dbError(e.message);
  }
}
