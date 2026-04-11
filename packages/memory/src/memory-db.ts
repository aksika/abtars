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
    version: 13,
    label: "full schema (collapsed from v1–v13)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          telegram_chat_id INTEGER NOT NULL, acp_session_id TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
          PRIMARY KEY (telegram_chat_id, acp_session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active, last_activity_at);

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, session_id TEXT NOT NULL,
          role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL,
          platform_message_id INTEGER, emotion_score INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_platform_id ON messages(chat_id, platform_message_id);

        CREATE TABLE IF NOT EXISTS embeddings (
          content_hash TEXT PRIMARY KEY, message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
          vector BLOB NOT NULL, model_version TEXT DEFAULT 'Xenova/all-MiniLM-L6-v2'
        );

        CREATE TABLE IF NOT EXISTS compactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, source_session_id TEXT NOT NULL,
          tier TEXT NOT NULL DEFAULT 'daily', timestamp INTEGER NOT NULL, summary TEXT NOT NULL, file_path TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_compactions_chat_tier_ts ON compactions(chat_id, tier, timestamp DESC);

        CREATE TABLE IF NOT EXISTS ingested_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, source_type TEXT NOT NULL,
          identifier TEXT NOT NULL, chunk_count INTEGER NOT NULL, ingested_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ingested_docs_chat ON ingested_documents(chat_id);

        CREATE TABLE IF NOT EXISTS extracted_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL,
          content_original TEXT NOT NULL, content_en TEXT NOT NULL,
          memory_type TEXT NOT NULL DEFAULT 'fact', source_timestamp INTEGER NOT NULL,
          preserve_original INTEGER NOT NULL DEFAULT 0, preserved_keyword TEXT, created_at INTEGER NOT NULL,
          emotion_score INTEGER DEFAULT 0, recall_count INTEGER DEFAULT 0, last_recalled_at INTEGER,
          relevance_score INTEGER DEFAULT 0, confidence INTEGER DEFAULT 3, source_message_ids TEXT,
          classification INTEGER DEFAULT 1, trust INTEGER DEFAULT 0, integrity INTEGER DEFAULT 2,
          credibility INTEGER DEFAULT 6, embedding BLOB, edited_at INTEGER, edited_by TEXT,
          emotion_tags TEXT, importance_flags TEXT, emotion_arc TEXT, signature BLOB,
          source_type TEXT DEFAULT 'conversation', topic TEXT DEFAULT 'general', tier TEXT DEFAULT 'general',
          valid_from TEXT, valid_to TEXT, emotion_context TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_extracted_memories_chat_ts ON extracted_memories(chat_id, source_timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_extracted_memories_preserve ON extracted_memories(preserve_original) WHERE preserve_original = 1;
        CREATE INDEX IF NOT EXISTS idx_extracted_memories_chat_created ON extracted_memories(chat_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_em_topic ON extracted_memories(topic);
        CREATE INDEX IF NOT EXISTS idx_em_tier ON extracted_memories(tier);
        CREATE INDEX IF NOT EXISTS idx_em_valid ON extracted_memories(valid_to);

        CREATE VIRTUAL TABLE IF NOT EXISTS extracted_memories_fts USING fts5(
          content_en, content=extracted_memories, content_rowid=id, tokenize='porter unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS extracted_memories_ai AFTER INSERT ON extracted_memories BEGIN
          INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (new.id, new.content_en);
        END;
        CREATE TRIGGER IF NOT EXISTS extracted_memories_ad AFTER DELETE ON extracted_memories BEGIN
          INSERT INTO extracted_memories_fts(extracted_memories_fts, rowid, content_en) VALUES('delete', old.id, old.content_en);
        END;
        CREATE TRIGGER IF NOT EXISTS extracted_memories_au AFTER UPDATE OF content_en ON extracted_memories BEGIN
          INSERT INTO extracted_memories_fts(extracted_memories_fts, rowid, content_en) VALUES('delete', old.id, old.content_en);
          INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (new.id, new.content_en);
        END;

        CREATE TABLE IF NOT EXISTS extraction_watermarks (chat_id INTEGER PRIMARY KEY, last_processed_timestamp INTEGER NOT NULL);

        CREATE TABLE IF NOT EXISTS chat_backup (
          id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, session_id TEXT NOT NULL,
          role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_backup_chat_ts ON chat_backup(chat_id, timestamp);

        CREATE TABLE IF NOT EXISTS cron_entries (
          id TEXT PRIMARY KEY, fire_at INTEGER NOT NULL, message TEXT NOT NULL, chat_id INTEGER NOT NULL,
          type TEXT NOT NULL DEFAULT 'task', executor TEXT, schedule TEXT, priority TEXT, task_file TEXT,
          paused INTEGER NOT NULL DEFAULT 0, fired INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
          last_ran_at INTEGER, retry_after INTEGER, retrying INTEGER NOT NULL DEFAULT 0, history TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'unknown', summary TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_entities (memory_id INTEGER NOT NULL, entity_id INTEGER NOT NULL, PRIMARY KEY (memory_id, entity_id));
        CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);

        CREATE TABLE IF NOT EXISTS memory_embeddings (memory_id INTEGER PRIMARY KEY, embedding BLOB, quantized INTEGER DEFAULT 0);

        CREATE VIRTUAL TABLE IF NOT EXISTS content_en_trigram USING fts5(content, tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS content_en_trigram_ai AFTER INSERT ON extracted_memories BEGIN
          INSERT INTO content_en_trigram(rowid, content) VALUES (new.id, strip_diacritics(COALESCE(new.content_en, '') || ' ' || COALESCE(new.preserved_keyword, '')));
        END;
        CREATE TRIGGER IF NOT EXISTS content_en_trigram_ad AFTER DELETE ON extracted_memories BEGIN
          DELETE FROM content_en_trigram WHERE rowid = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS content_en_trigram_au AFTER UPDATE OF content_en, preserved_keyword ON extracted_memories BEGIN
          DELETE FROM content_en_trigram WHERE rowid = old.id;
          INSERT INTO content_en_trigram(rowid, content) VALUES (new.id, strip_diacritics(COALESCE(new.content_en, '') || ' ' || COALESCE(new.preserved_keyword, '')));
        END;

        CREATE VIRTUAL TABLE IF NOT EXISTS content_original_trigram USING fts5(content, tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS content_original_trigram_ai AFTER INSERT ON extracted_memories BEGIN
          INSERT INTO content_original_trigram(rowid, content) VALUES (new.id, strip_diacritics(COALESCE(new.content_original, '')));
        END;
        CREATE TRIGGER IF NOT EXISTS content_original_trigram_ad AFTER DELETE ON extracted_memories BEGIN
          DELETE FROM content_original_trigram WHERE rowid = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS content_original_trigram_au AFTER UPDATE OF content_original ON extracted_memories BEGIN
          DELETE FROM content_original_trigram WHERE rowid = old.id;
          INSERT INTO content_original_trigram(rowid, content) VALUES (new.id, strip_diacritics(COALESCE(new.content_original, '')));
        END;
      `);
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
