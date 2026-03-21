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
      timestamp INTEGER NOT NULL,
      platform_message_id INTEGER,
      emotion_score INTEGER DEFAULT 0
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

  // Extracted memories table (Tier 3 Collection)
  db.exec(`
    CREATE TABLE IF NOT EXISTS extracted_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      content_original TEXT NOT NULL,
      content_en TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'fact',
      source_timestamp INTEGER NOT NULL,
      preserve_original INTEGER NOT NULL DEFAULT 0,
      preserved_keyword TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_extracted_memories_chat_ts
      ON extracted_memories(chat_id, source_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_extracted_memories_preserve
      ON extracted_memories(preserve_original) WHERE preserve_original = 1;

    -- FTS5 index over extracted memories (English content)
    CREATE VIRTUAL TABLE IF NOT EXISTS extracted_memories_fts USING fts5(
      content_en,
      content=extracted_memories,
      content_rowid=id,
      tokenize='porter unicode61'
    );

    -- Triggers to keep extracted memories FTS in sync
    CREATE TRIGGER IF NOT EXISTS extracted_memories_ai AFTER INSERT ON extracted_memories BEGIN
      INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (new.id, new.content_en);
    END;

    CREATE TRIGGER IF NOT EXISTS extracted_memories_ad AFTER DELETE ON extracted_memories BEGIN
      INSERT INTO extracted_memories_fts(extracted_memories_fts, rowid, content_en)
        VALUES('delete', old.id, old.content_en);
    END;

    -- FTS5 index for original-language content (only for preserve_original memories)
    CREATE VIRTUAL TABLE IF NOT EXISTS extracted_memories_original_fts USING fts5(
      content_original,
      content=extracted_memories,
      content_rowid=id,
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS extracted_memories_orig_ai AFTER INSERT ON extracted_memories
      WHEN new.preserve_original = 1
    BEGIN
      INSERT INTO extracted_memories_original_fts(rowid, content_original)
        VALUES (new.id, new.content_original);
    END;

    CREATE TRIGGER IF NOT EXISTS extracted_memories_orig_ad AFTER DELETE ON extracted_memories
      WHEN old.preserve_original = 1
    BEGIN
      INSERT INTO extracted_memories_original_fts(extracted_memories_original_fts, rowid, content_original)
        VALUES('delete', old.id, old.content_original);
    END;

    -- Extraction watermark table (tracks last processed timestamp per chat)
    CREATE TABLE IF NOT EXISTS extraction_watermarks (
      chat_id INTEGER PRIMARY KEY,
      last_processed_timestamp INTEGER NOT NULL
    );

    -- Chat backup: immutable copy of messages, never touched by LLM/sleep.
    -- Pruned on startup by wired logic (>7 days).
    CREATE TABLE IF NOT EXISTS chat_backup (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_backup_chat_ts
      ON chat_backup(chat_id, timestamp);
  `);

  // Migration: add model_version column to embeddings table for existing databases
  try {
    db.exec(`ALTER TABLE embeddings ADD COLUMN model_version TEXT DEFAULT 'Xenova/all-MiniLM-L6-v2'`);
  } catch (_) {
    // Column already exists — safe to ignore
  }

  // Register strip_emojis() scalar function for FTS5 triggers.
  // Messages store raw content (emojis preserved for retrospective sarcasm detection).
  // FTS5 index gets emoji-stripped text so search isn't polluted.
  db.function("strip_emojis", (text: unknown) => {
    if (typeof text !== "string") return text;
    return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").replace(/ {2,}/g, " ").trim();
  });

  // Migration: recreate FTS5 triggers to use strip_emojis() (R1 — raw content in messages)
  db.exec(`
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;

    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, strip_emojis(new.content));
    END;

    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES('delete', old.id, strip_emojis(old.content));
    END;
  `);

  logInfo(TAG, `Database initialized at ${dbPath}`);
  return db;
}
