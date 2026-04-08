import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logInfo } from "./mem-logger.js";

const TAG = "memory-db";

// ── Custom scalar functions (registered before migrations, used at runtime) ──

function registerFunctions(db: Database.Database): void {
  db.function("strip_emojis", (text: unknown) => {
    if (typeof text !== "string") return text;
    return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").replace(/ {2,}/g, " ").trim();
  });

  db.function("strip_diacritics", (text: unknown) => {
    if (typeof text !== "string") return text;
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  });
}

// ── Migrations ──────────────────────────────────────────────────────────────

interface Migration {
  readonly version: number;
  readonly label: string;
  readonly up: (db: Database.Database) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    label: "core tables (sessions, messages, FTS, embeddings, ingested_documents)",
    up: (db) => {
      db.exec(`
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

        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          content,
          content=messages,
          content_rowid=id,
          tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
            VALUES('delete', old.id, old.content);
        END;

        CREATE TABLE IF NOT EXISTS embeddings (
          content_hash TEXT PRIMARY KEY,
          message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
          vector BLOB NOT NULL,
          model_version TEXT DEFAULT 'Xenova/all-MiniLM-L6-v2'
        );

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
    },
  },
  {
    version: 2,
    label: "extracted memories, FTS, triggers, watermarks, chat_backup",
    up: (db) => {
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

        CREATE VIRTUAL TABLE IF NOT EXISTS extracted_memories_fts USING fts5(
          content_en,
          content=extracted_memories,
          content_rowid=id,
          tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS extracted_memories_ai AFTER INSERT ON extracted_memories BEGIN
          INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (new.id, new.content_en);
        END;
        CREATE TRIGGER IF NOT EXISTS extracted_memories_ad AFTER DELETE ON extracted_memories BEGIN
          INSERT INTO extracted_memories_fts(extracted_memories_fts, rowid, content_en)
            VALUES('delete', old.id, old.content_en);
        END;
        CREATE TRIGGER IF NOT EXISTS extracted_memories_au AFTER UPDATE OF content_en ON extracted_memories BEGIN
          INSERT INTO extracted_memories_fts(extracted_memories_fts, rowid, content_en)
            VALUES('delete', old.id, old.content_en);
          INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (new.id, new.content_en);
        END;

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
        CREATE TRIGGER IF NOT EXISTS extracted_memories_orig_au AFTER UPDATE OF content_original ON extracted_memories
          WHEN new.preserve_original = 1
        BEGIN
          INSERT INTO extracted_memories_original_fts(extracted_memories_original_fts, rowid, content_original)
            VALUES('delete', old.id, old.content_original);
          INSERT INTO extracted_memories_original_fts(rowid, content_original)
            VALUES (new.id, new.content_original);
        END;

        CREATE TABLE IF NOT EXISTS extraction_watermarks (
          chat_id INTEGER PRIMARY KEY,
          last_processed_timestamp INTEGER NOT NULL
        );

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
    },
  },
  {
    version: 3,
    label: "entity linking tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL DEFAULT 'unknown',
          summary TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_entities (
          memory_id INTEGER NOT NULL,
          entity_id INTEGER NOT NULL,
          PRIMARY KEY (memory_id, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);
      `);
    },
  },
  {
    version: 4,
    label: "column additions (embedding, scoring, trust, edit tracking)",
    up: (db) => {
      for (const ddl of [
        "ALTER TABLE extracted_memories ADD COLUMN embedding BLOB",
        "ALTER TABLE extracted_memories ADD COLUMN emotion_score INTEGER DEFAULT 0",
        "ALTER TABLE extracted_memories ADD COLUMN recall_count INTEGER DEFAULT 0",
        "ALTER TABLE extracted_memories ADD COLUMN last_recalled_at INTEGER",
        "ALTER TABLE extracted_memories ADD COLUMN relevance_score INTEGER DEFAULT 0",
        "ALTER TABLE extracted_memories ADD COLUMN confidence INTEGER DEFAULT 3",
        "ALTER TABLE extracted_memories ADD COLUMN source_message_ids TEXT",
        "ALTER TABLE extracted_memories ADD COLUMN classification INTEGER DEFAULT 1",
        "ALTER TABLE extracted_memories ADD COLUMN trust INTEGER DEFAULT 0",
        "ALTER TABLE extracted_memories ADD COLUMN integrity INTEGER DEFAULT 2",
        "ALTER TABLE extracted_memories ADD COLUMN credibility INTEGER DEFAULT 6",
        "ALTER TABLE extracted_memories ADD COLUMN edited_at INTEGER",
        "ALTER TABLE extracted_memories ADD COLUMN edited_by TEXT",
      ]) {
        try { db.exec(ddl); } catch { /* column already exists */ }
      }
    },
  },
  {
    version: 5,
    label: "data consolidation + indexes",
    up: (db) => {
      try { db.exec("UPDATE extracted_memories SET created_at = source_timestamp WHERE created_at != source_timestamp"); } catch { /* */ }
      db.exec("CREATE INDEX IF NOT EXISTS idx_extracted_memories_chat_created ON extracted_memories(chat_id, created_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_messages_platform_id ON messages(chat_id, platform_message_id)");
    },
  },
  {
    version: 6,
    label: "strip_emojis FTS triggers",
    up: (db) => {
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
    },
  },
  {
    version: 7,
    label: "ABM v1 — topic, tier, temporal validity",
    up: (db) => {
      for (const ddl of [
        "ALTER TABLE extracted_memories ADD COLUMN topic TEXT DEFAULT 'general'",
        "ALTER TABLE extracted_memories ADD COLUMN tier TEXT DEFAULT 'general'",
        "ALTER TABLE extracted_memories ADD COLUMN valid_from TEXT",
        "ALTER TABLE extracted_memories ADD COLUMN valid_to TEXT",
      ]) {
        try { db.exec(ddl); } catch { /* column already exists */ }
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_em_topic ON extracted_memories(topic);
        CREATE INDEX IF NOT EXISTS idx_em_tier ON extracted_memories(tier);
        CREATE INDEX IF NOT EXISTS idx_em_valid ON extracted_memories(valid_to);
      `);
    },
  },
  {
    version: 8,
    label: "ABM v2 — emotion tags, importance flags, ABM-L, signatures, brain patterns",
    up: (db) => {
      for (const ddl of [
        "ALTER TABLE extracted_memories ADD COLUMN emotion_tags TEXT",
        "ALTER TABLE extracted_memories ADD COLUMN importance_flags TEXT",
        "ALTER TABLE extracted_memories ADD COLUMN content_compressed TEXT",
        "ALTER TABLE extracted_memories ADD COLUMN emotion_arc TEXT",
        "ALTER TABLE extracted_memories ADD COLUMN related_topics TEXT",
        "ALTER TABLE extracted_memories ADD COLUMN signature BLOB",
        "ALTER TABLE extracted_memories ADD COLUMN source_type TEXT DEFAULT 'conversation'",
        "ALTER TABLE extracted_memories ADD COLUMN last_recall_context TEXT",
      ]) {
        try { db.exec(ddl); } catch { /* column already exists */ }
      }
    },
  },
  {
    version: 9,
    label: "ABM-L FTS5 index + embedding separation",
    up: (db) => {
      // FTS5 on content_compressed (ABM-L) — survives aging
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS abml_fts USING fts5(
          content_compressed,
          content=extracted_memories,
          content_rowid=id,
          tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS abml_fts_ai AFTER INSERT ON extracted_memories BEGIN
          INSERT INTO abml_fts(rowid, content_compressed) VALUES (new.id, COALESCE(new.content_compressed, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS abml_fts_ad AFTER DELETE ON extracted_memories BEGIN
          INSERT INTO abml_fts(abml_fts, rowid, content_compressed) VALUES('delete', old.id, COALESCE(old.content_compressed, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS abml_fts_au AFTER UPDATE OF content_compressed ON extracted_memories BEGIN
          INSERT INTO abml_fts(abml_fts, rowid, content_compressed) VALUES('delete', old.id, COALESCE(old.content_compressed, ''));
          INSERT INTO abml_fts(rowid, content_compressed) VALUES (new.id, COALESCE(new.content_compressed, ''));
        END;
      `);

      // Populate ABM-L FTS from existing data
      try {
        db.exec("INSERT INTO abml_fts(rowid, content_compressed) SELECT id, COALESCE(content_compressed, '') FROM extracted_memories");
      } catch { /* already populated */ }

      // Separate embedding table
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_embeddings (
          memory_id INTEGER PRIMARY KEY,
          embedding BLOB,
          quantized INTEGER DEFAULT 0
        );
      `);

      // Migrate existing embeddings to separate table
      try {
        db.exec(`
          INSERT OR IGNORE INTO memory_embeddings (memory_id, embedding, quantized)
          SELECT id, embedding, 0 FROM extracted_memories WHERE embedding IS NOT NULL
        `);
      } catch { /* */ }
    },
  },
];

// ── Migration runner ────────────────────────────────────────────────────────

function runMigrations(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");

  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let current = row?.version ?? 0;

  if (!row) {
    // First run with versioning — detect pre-existing databases
    const hasMessages = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get();
    if (hasMessages) {
      const latest = MIGRATIONS.at(-1)!.version;
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(latest);
      logInfo(TAG, `Pre-versioning database detected, set to version ${String(latest)}`);
      return;
    }
    db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  }

  const pending = MIGRATIONS.filter(m => m.version > current);
  if (pending.length === 0) return;

  const tx = db.transaction(() => {
    for (const m of pending) {
      m.up(db);
      db.prepare("UPDATE schema_version SET version = ?").run(m.version);
      logInfo(TAG, `Migration ${String(m.version)}: ${m.label}`);
    }
  });
  tx();
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Opens (or creates) the SQLite database at the given path, registers
 * custom functions, and runs any pending schema migrations.
 */
export function initializeDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  registerFunctions(db);
  runMigrations(db);

  logInfo(TAG, `Database initialized at ${dbPath}`);
  return db;
}
