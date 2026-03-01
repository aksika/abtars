import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logInfo } from "./logger.js";

const TAG = "memory-db";

/**
 * Opens (or creates) the SQLite database at the given path and initializes
 * the full schema: sessions, messages, FTS5 virtual table, sync triggers,
 * embeddings cache, and compaction summaries.
 *
 * Enables WAL mode for better concurrent read performance and foreign keys.
 */
export function initializeDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    -- Session state table
    CREATE TABLE IF NOT EXISTS sessions (
      telegram_chat_id INTEGER NOT NULL,
      acp_session_id TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      PRIMARY KEY (telegram_chat_id, acp_session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_active
      ON sessions(is_active, last_activity_at);

    -- Messages table (source for FTS)
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts
      ON messages(chat_id, timestamp);

    -- FTS5 virtual table
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content=messages,
      content_rowid=id,
      tokenize='porter unicode61'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES('delete', old.id, old.content);
    END;

    -- Embedding cache (keyed by SHA-256 hash of source text)
    CREATE TABLE IF NOT EXISTS embeddings (
      content_hash TEXT PRIMARY KEY,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      vector BLOB NOT NULL,
      model_version TEXT DEFAULT 'Xenova/all-MiniLM-L6-v2'
    );

    -- Compaction summaries (all tiers)
    CREATE TABLE IF NOT EXISTS compactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      source_session_id TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'daily',
      timestamp INTEGER NOT NULL,
      summary TEXT NOT NULL,
      file_path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_compactions_chat_tier_ts
      ON compactions(chat_id, tier, timestamp DESC);

    -- Ingested documents metadata (Phase 2)
    CREATE TABLE IF NOT EXISTS ingested_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      identifier TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ingested_docs_chat
      ON ingested_documents(chat_id);
  `);

  // Migration: add model_version column to embeddings table for existing databases
  try {
    db.exec(`ALTER TABLE embeddings ADD COLUMN model_version TEXT DEFAULT 'Xenova/all-MiniLM-L6-v2'`);
  } catch (_) {
    // Column already exists — safe to ignore
  }

  logInfo(TAG, `Database initialized at ${dbPath}`);
  return db;
}
