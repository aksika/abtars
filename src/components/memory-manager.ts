import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { loadEmbedConfig, embedText } from "./ollama-embed.js";
import { HeartbeatSystem } from "./heartbeat-system.js";
import { getLatestConsolidationFile } from "./consolidation-search.js";
import { ReflectionEngine } from "./reflection-engine.js";
import type {
  MessageRecord,
  SessionState,
  StoredSession,
  SearchResult,
  SearchOptions,
  Reflection,
  ForgetResult,
  InstantStoreParams,
  InstantStoreResult,
  EditMemoryParams,
  EditMemoryResult,
} from "../types/index.js";
import { clampEmotionScore } from "./emotion-utils.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { localDate } from "./env-utils.js";

const TAG = "memory-manager";

/**
 * Top-level coordinator for the local memory layer.
 *
 * Owns the SQLite database and FTS index.
 * When `memoryEnabled` is false, all methods are no-ops.
 * All public methods are wrapped in try/catch — they never throw.
 */
export class MemoryManager {
  private readonly config: MemoryConfig;
  private db: Database.Database | null = null;
  private memoryIndex: MemoryIndex | null = null;
  private writeCounter: number = 0;
  private llmCall: ((prompt: string, content: string) => Promise<string>) | null = null;
  private reflectionEngine: ReflectionEngine | null = null;
  private heartbeat: HeartbeatSystem | null = null;

  constructor(config: MemoryConfig) {
    this.config = config;
  }

  /** Register a callback that returns true when the transport is busy (e.g. processing a user prompt). */
  setIsBusy(_fn: () => boolean): void {
  }

  /** Register the LLM callback. Called once from main.ts after transport is ready. */
  setLlmCall(llmCall: (prompt: string, content: string) => Promise<string>): void {
    this.llmCall = llmCall;
  }

  /** Get the stored LLM callback, or null if not set. */
  getLlmCall(): ((prompt: string, content: string) => Promise<string>) | null {
    return this.llmCall;
  }

  /** Expose the underlying MemoryIndex for direct search access (used by MemorySearchController). */
  getMemoryIndex(): MemoryIndex | null {
    return this.memoryIndex;
  }

  /** Register the BrowserManager for webpage ingestion. Called from main.ts after BrowserManager is created. */
  setBrowserManager(_bm: import("./browser-manager.js").BrowserManager): void {
    // Reserved for future ingestion pipeline
  }

  /** Expose the underlying database for direct query access (used by MemorySearchController). */
  getDatabase(): import("better-sqlite3").Database | null {
    return this.db;
  }

  /** Expose the memory configuration (used by main.ts for threshold checks). */
  getConfig(): MemoryConfig {
    return this.config;
  }


  /** Initialize database, create directories, and set up sub-components. */
  async initialize(): Promise<void> {
    if (!this.config.memoryEnabled) return;

    try {
      mkdirSync(this.config.memoryDir, { recursive: true });

      const dbPath = join(this.config.memoryDir, "memory.db");
      this.db = initializeDatabase(dbPath);

      // Idempotent migration: add emotion_score column if it doesn't exist
      try {
        this.db.exec("ALTER TABLE extracted_memories ADD COLUMN emotion_score INTEGER DEFAULT 0");
      } catch {
        // Column already exists — safe to ignore
      }

      // Idempotent migration: Memory Darwinism + source linking columns
      for (const ddl of [
        "ALTER TABLE extracted_memories ADD COLUMN recall_count INTEGER DEFAULT 0",
        "ALTER TABLE extracted_memories ADD COLUMN last_recalled_at INTEGER",
        "ALTER TABLE extracted_memories ADD COLUMN relevance_score INTEGER DEFAULT 0",
        "ALTER TABLE extracted_memories ADD COLUMN confidence INTEGER DEFAULT 3",
        "ALTER TABLE extracted_memories ADD COLUMN source_message_ids TEXT",
        "ALTER TABLE extracted_memories ADD COLUMN classification INTEGER DEFAULT 1",
        "ALTER TABLE extracted_memories ADD COLUMN trust INTEGER DEFAULT 0",
        "ALTER TABLE extracted_memories ADD COLUMN integrity INTEGER DEFAULT 2",
        "ALTER TABLE extracted_memories ADD COLUMN credibility INTEGER DEFAULT 6",
      ]) {
        try { this.db.exec(ddl); } catch { /* already exists */ }
      }

      // Idempotent migration: edited_at + edited_by for memory edit tool
      for (const ddl of [
        "ALTER TABLE extracted_memories ADD COLUMN edited_at INTEGER",
        "ALTER TABLE extracted_memories ADD COLUMN edited_by TEXT",
      ]) {
        try { this.db.exec(ddl); } catch { /* already exists */ }
      }

      // Idempotent migration: consolidate source_timestamp into created_at
      // Copy source_timestamp values to created_at where they differ, then use created_at everywhere.
      // source_timestamp column stays in schema (SQLite can't drop columns) but is no longer written/read.
      try {
        this.db.exec("UPDATE extracted_memories SET created_at = source_timestamp WHERE created_at != source_timestamp");
      } catch { /* safe to ignore */ }

      // Idempotent migration: add index on created_at (replaces source_timestamp index for queries)
      try {
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_extracted_memories_chat_created ON extracted_memories(chat_id, created_at DESC)");
      } catch { /* already exists */ }

      // Idempotent migration: add platform_message_id + emotion_score to messages
      try {
        this.db.exec("ALTER TABLE messages ADD COLUMN platform_message_id INTEGER");
      } catch { /* already exists */ }
      try {
        this.db.exec("ALTER TABLE messages ADD COLUMN emotion_score INTEGER DEFAULT 0");
      } catch { /* already exists */ }
      try {
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_messages_platform_id ON messages(chat_id, platform_message_id)");
      } catch { /* already exists */ }

      this.memoryIndex = new MemoryIndex(this.db);

      // Ollama embedding health check (Se sidecar for recall)
      const embedConfig = loadEmbedConfig();
      if (embedConfig.enabled) {
        try {
          const res = await fetch(`${embedConfig.url}/api/tags`);
          if (res.ok) {
            const data = await res.json() as { models?: Array<{ name: string }> };
            const models = data.models?.map(m => m.name) ?? [];
            const hasModel = models.some(m => m.startsWith(embedConfig.model));
            if (hasModel) {
              logInfo(TAG, `Embedding enabled: ${embedConfig.model} via ollama (Se sidecar ready)`);
            } else {
              logWarn(TAG, `Embedding model '${embedConfig.model}' not found in ollama (available: ${models.join(", ")})`);
            }
          } else {
            logWarn(TAG, `Ollama health check failed (HTTP ${res.status}) — Se sidecar will fail at recall time`);
          }
        } catch (err) {
          logWarn(TAG, `Ollama unreachable at ${embedConfig.url} — Se sidecar disabled`);
        }
      }

      logInfo(TAG, "Memory manager initialized");

      // Initialize reflection engine (doesn't require vector search)
      if (this.db) {
        this.reflectionEngine = new ReflectionEngine(this.db, this.config);
        logInfo(TAG, "Reflection engine enabled");
      }

      // Run disk budget enforcement on startup
      this.enforceDiskBudget();

      // Prune chat_backup entries older than 7 days (wired logic, not LLM-controlled)
      this.pruneBackup();
    } catch (err) {
      logError(TAG, "Failed to initialize memory manager", err);
    }
  }

  /** Persist a session state row (INSERT OR REPLACE). */
  persistSession(session: SessionState): void {
    if (!this.config.memoryEnabled || !this.db) return;

    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO sessions (telegram_chat_id, acp_session_id, is_active, created_at, last_activity_at)
           VALUES (?, ?, 1, ?, ?)`,
        )
        .run(
          session.channelKey,
          session.acpSessionId,
          session.createdAt,
          session.lastActivityAt,
        );
    } catch (err) {
      logError(TAG, "Failed to persist session", err);
    }
  }

  /** Update lastActivityAt for a session. */
  touchSession(channelKey: string, sessionId: string): void {
    if (!this.config.memoryEnabled || !this.db) return;

    try {
      this.db
        .prepare(
          `UPDATE sessions SET last_activity_at = ? WHERE telegram_chat_id = ? AND acp_session_id = ?`,
        )
        .run(Date.now(), channelKey, sessionId);
    } catch (err) {
      logError(TAG, "Failed to touch session", err);
    }
  }

  /** Mark a session as inactive. */
  deactivateSession(channelKey: string, sessionId: string): void {
    if (!this.config.memoryEnabled || !this.db) return;

    try {
      this.db
        .prepare(
          `UPDATE sessions SET is_active = 0 WHERE telegram_chat_id = ? AND acp_session_id = ?`,
        )
        .run(channelKey, sessionId);
    } catch (err) {
      logError(TAG, "Failed to deactivate session", err);
    }
  }

  /** Restore active sessions whose lastActivityAt is within the staleness threshold. */
  restoreSessions(stalenessMs: number): StoredSession[] {
    if (!this.config.memoryEnabled || !this.db) return [];

    try {
      const cutoff = Date.now() - stalenessMs;
      const rows = this.db
        .prepare(
          `SELECT telegram_chat_id, acp_session_id, created_at, last_activity_at
           FROM sessions
           WHERE is_active = 1 AND last_activity_at >= ?`,
        )
        .all(cutoff) as Array<{
        telegram_chat_id: number;
        acp_session_id: string;
        created_at: number;
        last_activity_at: number;
      }>;

      return rows.map((row) => ({
        channelKey: String(row.telegram_chat_id),
        acpSessionId: row.acp_session_id,
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
      }));
    } catch (err) {
      logError(TAG, "Failed to restore sessions", err);
      return [];
    }
  }

  /**
   * Record a conversation message: index in FTS (raw content, emojis stripped
   * at FTS5 trigger level), optionally index in vector store, enforce message
   * limits, and periodically enforce disk budget.
   *
   * When `memoryEnabled` is false, this is a no-op.
   * Never throws — all errors are caught and logged.
   */
  recordMessage(record: MessageRecord): void {
    if (!this.config.memoryEnabled || !this.db) return;

    try {
      // Skip empty content after stripping whitespace
      if (!record.content.trim()) return;

      // 1. Index in FTS (raw content — FTS5 trigger strips emojis at index level)
      if (!this.memoryIndex) return;
      this.memoryIndex.index(record);

      // 2. Immutable backup copy (debug-only — controlled by DEBUG_MODE env var)
      if (process.env["DEBUG_MODE"] === "true" || process.env["DEBUG_MODE"] === "1") {
        this.db.prepare(
          "INSERT INTO chat_backup (chat_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
        ).run(record.chatId, record.sessionId, record.role, record.content, record.timestamp);
      }

      // 5. Prune if chat exceeds maxMessagesPerChat
      if (this.config.maxMessagesPerChat > 0) {
        this.memoryIndex.prune(record.chatId, this.config.maxMessagesPerChat);
      }

      // 5. Increment write counter and enforce disk budget every 100 writes
      this.writeCounter++;
      if (this.writeCounter % 100 === 0) {
        this.enforceDiskBudget();
      }
    } catch (err) {
      logError(TAG, "Failed to record message", err);
    }
  }

  /** Update emotion_score on a message identified by platform message ID.
   *  Propagates to linked extracted_memories immediately.
   *  Returns true if the message was updated. */
  updateEmotionByPlatformId(chatId: number | string, platformMessageId: number, score: number): boolean {
    if (!this.db) return false;
    try {
      const result = this.db.prepare(
        "UPDATE messages SET emotion_score = ? WHERE chat_id = ? AND platform_message_id = ?",
      ).run(score, chatId, platformMessageId);
      if (result.changes === 0) return false;

      // Cascade to extracted_memories via editMemory
      this.editMemory({ messageId: platformMessageId, chatId: typeof chatId === "string" ? parseInt(chatId, 10) : chatId, emotionScore: score });
      return true;
    } catch (err) {
      logError(TAG, "Failed to update emotion score", err);
      return false;
    }
  }


  /** Search conversation history via FTS5. */
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    if (!this.config.memoryEnabled || !this.memoryIndex) return [];
    try {
      return this.memoryIndex.search(query, opts);
    } catch (err) {
      logError(TAG, "Search failed", err);
      return [];
    }
  }

  /** Substring search using SQL LIKE — catches compound words that FTS5 misses. */
  substringSearch(query: string, opts?: SearchOptions): SearchResult[] {
    if (!this.config.memoryEnabled || !this.memoryIndex) return [];
    try {
      return this.memoryIndex.substringSearch(query, opts);
    } catch (err) {
      logError(TAG, "Substring search failed", err);
      return [];
    }
  }

  /** Read user profile + agent notes from core/. */
  readCoreKnowledge(): string {
    if (!this.config.memoryEnabled) return "";

    const parts: string[] = [];
    for (const file of ["user_profile.md", "agent_notes.md"]) {
      try {
        const filePath = join(this.config.memoryDir, "core", file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8").trim();
          if (content) parts.push(content);
        }
      } catch (err) {
        logError(TAG, `Failed to read core/${file}`, err);
      }
    }
    return parts.join("\n\n");
  }

  /** Generate a reflection for the given channel over a time window. */
  async reflect(channelKey: string, windowDays?: number): Promise<Reflection> {
    if (!this.reflectionEngine) {
      throw new Error("Reflection engine is not available.");
    }
    if (!this.llmCall) {
      throw new Error("LLM is not available. Cannot generate reflection.");
    }
    return this.reflectionEngine.reflect({
      channelKey,
      llmCall: this.llmCall,
      windowDays,
    });
  }

  /** List available reflections for a channel. */
  listReflections(channelKey: string): Array<{ date: string; preview: string }> {
    if (!this.reflectionEngine) {
      return [];
    }
    return this.reflectionEngine.listReflections(channelKey);
  }

  /**
   * Enforce the configured disk budget by deleting the oldest transcript files
   * when total usage exceeds the limit. Also removes corresponding index entries.
  /** Delete chat_backup rows older than 7 days. Wired logic — no LLM involvement. */
  private pruneBackup(): void {
    if (!this.db) return;
    const cutoff = Date.now() - 7 * 24 * 3_600_000;
    const result = this.db.prepare("DELETE FROM chat_backup WHERE timestamp < ?").run(cutoff);
    if (result.changes > 0) {
      logInfo(TAG, `Pruned ${result.changes} chat_backup rows older than 7 days`);
    }
  }

  /**
   * Enforce disk budget by checking DB size against configured limit.
   * Runs on startup and after every 100 recordMessage() calls.
   */
  enforceDiskBudget(): void {
    if (!this.config.memoryEnabled) return;

    try {
      const dbPath = join(this.config.memoryDir, "memory.db");
      let dbSize = 0;
      try {
        if (existsSync(dbPath)) {
          dbSize = statSync(dbPath).size;
        }
      } catch { /* ignore stat errors */ }

      if (dbSize > this.config.diskBudgetBytes) {
        logWarn(TAG, `DB size ${(dbSize / 1024 / 1024).toFixed(1)}MB exceeds budget ${(this.config.diskBudgetBytes / 1024 / 1024).toFixed(0)}MB`);
      }
    } catch (err) {
      logError(TAG, "Disk budget enforcement failed", err);
    }
  }

  /**
   * Check if the current session transcript exceeds the auto-compact threshold
   * and silently trigger daily compaction if needed.
   *
   * Estimates token count using chars / 4 heuristic. When over threshold,
   * Sends /compact to kiro-cli when context window exceeds threshold.
   * Writes safety-net transcript to working directory first.
   *
   * On failure, logs error and continues.
   * When memoryEnabled is false, this is a no-op.
   * Never throws.
   */
  async checkAutoCompact(params: {
    chatId: number;
    sessionId: string;
    contextPercent: number;
    sendCompactCommand: (sessionKey: string, command: string) => Promise<string>;
  }): Promise<void> {
    if (!this.config.memoryEnabled || !this.db) return;

    const threshold = this.config.searchEnhancements.compactThresholdPct;
    if (params.contextPercent < threshold) return;

    logInfo(
      TAG,
      `Auto-compact triggered for chat ${params.chatId} session ${params.sessionId} (context ${params.contextPercent}% >= ${threshold}% threshold)`,
    );

    try {
      // Write DB messages to working directory as safety net
      const messages = this.db.prepare(
        "SELECT role, content FROM messages WHERE chat_id = ? AND session_id = ? ORDER BY timestamp ASC",
      ).all(params.chatId, params.sessionId) as Array<{ role: string; content: string }>;

      if (messages.length > 0) {
        const dateStr = localDate();
        const workingDir = join(this.config.memoryDir, "working", dateStr);
        mkdirSync(workingDir, { recursive: true });
        const safetyPath = join(workingDir, `transcript_${params.chatId}.chat`);
        const rawContent = messages.map((m) => `[${m.role}] ${m.content}`).join("\n");
        if (existsSync(safetyPath)) {
          appendFileSync(safetyPath, `\n---\n\n${rawContent}`);
        } else {
          writeFileSync(safetyPath, rawContent);
        }
        logInfo(TAG, `Safety-net transcript written to ${safetyPath}`);
      }

      // Send /compact to kiro-cli for context window compression
      logInfo(TAG, `Sending /compact to Kiro CLI agent for chat ${params.chatId}`);
      await params.sendCompactCommand(params.sessionId, "/compact");
      logInfo(TAG, `Kiro CLI /compact completed for chat ${params.chatId}`);
    } catch (err) {
      logError(TAG, `Auto-compact failed for chat ${params.chatId} session ${params.sessionId} — raw transcript already saved as safety net`, err);
    }
  }


  /**
   * Load the most recent N messages from a session via DB query.
   * Returns empty array when memoryEnabled is false or on error.
   */
  loadRecentMessages(chatId: number, sessionId: string, count: number): MessageRecord[] {
    if (!this.config.memoryEnabled || !this.db) return [];

    try {
      const rows = this.db.prepare(
        "SELECT role, content, timestamp, chat_id AS chatId, session_id AS sessionId FROM messages WHERE chat_id = ? AND session_id = ? ORDER BY timestamp DESC LIMIT ?",
      ).all(chatId, sessionId, count) as MessageRecord[];
      return rows.reverse();
    } catch (err) {
      logError(TAG, `Failed to load recent messages for chat ${chatId} session ${sessionId}`, err);
      return [];
    }
  }

  /**
   * Cascade deletion through all storage layers for the given message IDs.
   *
   * Deletes from: embeddings table, FTS5 index (via trigger on messages delete),
   * and messages table.
   *
   * Returns a ForgetResult with counts from each layer.
   */
  cascadeDelete(messageIds: number[], chatId: number): ForgetResult {
    const result: ForgetResult = {
      messagesRemoved: 0,
      embeddingsRemoved: 0,
      transcriptEntriesRemoved: 0,
    };

    if (!this.db || messageIds.length === 0) return result;

    try {
      const placeholders = messageIds.map(() => "?").join(",");

      // 1. Delete from embeddings table
      const embeddingsResult = this.db
        .prepare(`DELETE FROM embeddings WHERE message_id IN (${placeholders})`)
        .run(...messageIds);
      result.embeddingsRemoved = embeddingsResult.changes;

      // 2. Delete from messages table (the AFTER DELETE trigger on messages
      //    automatically removes corresponding rows from messages_fts)
      const messagesResult = this.db
        .prepare(`DELETE FROM messages WHERE id IN (${placeholders})`)
        .run(...messageIds);
      result.messagesRemoved = messagesResult.changes;

      logInfo(
        TAG,
        `Cascade delete for chat ${chatId}: ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings`,
      );
    } catch (err) {
      logError(TAG, `Cascade delete failed for chat ${chatId}`, err);
    }

    return result;
  }

  /**
   * Forget all memories semantically related to a topic.
   * Uses hybrid search to find related messages above the relevance threshold,
   * then cascade deletes them from all storage layers.
   */
  async forgetTopic(chatId: number, topic: string, threshold?: number): Promise<ForgetResult> {
    const emptyResult: ForgetResult = {
      messagesRemoved: 0,
      embeddingsRemoved: 0,
      transcriptEntriesRemoved: 0,
    };

    if (!this.db) return emptyResult;

    try {
      const effectiveThreshold = threshold ?? this.config.forgetThreshold;

      // Use hybrid search to find semantically related messages
      const searchResults = await this.search(topic, { chatId, limit: 100 });

      // Filter results above the relevance threshold
      const relevant = searchResults.filter((r) => r.score >= effectiveThreshold);

      if (relevant.length === 0) {
        logInfo(TAG, `forgetTopic: no messages above threshold ${effectiveThreshold} for topic "${topic}" in chat ${chatId}`);
        return emptyResult;
      }

      // Look up message IDs from the messages table using chatId + sessionId + timestamp + role
      const messageIds: number[] = [];
      for (const r of relevant) {
        const row = this.db
          .prepare(
            "SELECT id FROM messages WHERE chat_id = ? AND session_id = ? AND timestamp = ? AND role = ?",
          )
          .get(r.record.chatId, r.record.sessionId, r.record.timestamp, r.record.role) as
          | { id: number }
          | undefined;
        if (row) {
          messageIds.push(row.id);
        }
      }

      if (messageIds.length === 0) {
        logInfo(TAG, `forgetTopic: no message IDs resolved for topic "${topic}" in chat ${chatId}`);
        return emptyResult;
      }

      const result = this.cascadeDelete(messageIds, chatId);


      logInfo(TAG, `forgetTopic: removed ${result.messagesRemoved} messages for topic "${topic}" in chat ${chatId}`);
      return result;
    } catch (err) {
      logError(TAG, `forgetTopic failed for chat ${chatId}, topic "${topic}"`, err);
      return emptyResult;
    }
  }

  /**
   * Forget all memories within a date range.
   * Finds messages by timestamp range and cascade deletes them.
   */
  forgetRange(chatId: number, startDate: Date, endDate: Date): ForgetResult {
    const emptyResult: ForgetResult = {
      messagesRemoved: 0,
      embeddingsRemoved: 0,
      transcriptEntriesRemoved: 0,
    };

    if (!this.db) return emptyResult;

    try {
      const startMs = startDate.getTime();
      const endMs = endDate.getTime();

      const rows = this.db
        .prepare("SELECT id FROM messages WHERE chat_id = ? AND timestamp >= ? AND timestamp <= ?")
        .all(chatId, startMs, endMs) as Array<{ id: number }>;

      if (rows.length === 0) {
        logInfo(TAG, `forgetRange: no messages found in range ${startDate.toISOString()} – ${endDate.toISOString()} for chat ${chatId}`);
        return emptyResult;
      }

      const messageIds = rows.map((r) => r.id);
      const result = this.cascadeDelete(messageIds, chatId);


      logInfo(TAG, `forgetRange: removed ${result.messagesRemoved} messages in range for chat ${chatId}`);
      return result;
    } catch (err) {
      logError(TAG, `forgetRange failed for chat ${chatId}`, err);
      return emptyResult;
    }
  }

  /**
   * Forget all memories for a specific session.
   * Finds messages by session ID and cascade deletes them.
   */
  forgetSession(chatId: number, sessionId: string): ForgetResult {
    const emptyResult: ForgetResult = {
      messagesRemoved: 0,
      embeddingsRemoved: 0,
      transcriptEntriesRemoved: 0,
    };

    if (!this.db) return emptyResult;

    try {
      const rows = this.db
        .prepare("SELECT id FROM messages WHERE chat_id = ? AND session_id = ?")
        .all(chatId, sessionId) as Array<{ id: number }>;

      if (rows.length === 0) {
        logInfo(TAG, `forgetSession: no messages found for session ${sessionId} in chat ${chatId}`);
        return emptyResult;
      }

      const messageIds = rows.map((r) => r.id);
      const result = this.cascadeDelete(messageIds, chatId);


      logInfo(TAG, `forgetSession: removed ${result.messagesRemoved} messages for session ${sessionId} in chat ${chatId}`);
      return result;
    } catch (err) {
      logError(TAG, `forgetSession failed for chat ${chatId}, session ${sessionId}`, err);
      return emptyResult;
    }
  }


  /**
   * Initialize and start the heartbeat system for background tasks.
   * Called after initialize() and setLlmCall().
   *
   * Creates HeartbeatSystem.
   * Registers heartbeat tasks:
   *   - sleep-trigger: checks every 5min (≥8am, 10min idle, once/day)
   *
   * On failure, logs a warning and continues without background processing.
   */

  /** Set the heartbeat reference (owned by main.ts). */
  setHeartbeat(hb: HeartbeatSystem): void { this.heartbeat = hb; }

  /** Expose DB for heartbeat tasks that need direct queries. */
  getDb(): Database.Database | null { return this.db; }

  /** Stop the heartbeat system. Called from close(). */
  stopHeartbeat(): void {
    this.heartbeat?.stop();
    this.heartbeat = null;
  }

  /** Get the latest daily compaction for a chat (for session-start injection). */
  getLatestCompaction(_chatId: number): { timestamp: number; summary: string } | null {
    try {
      const result = getLatestConsolidationFile(this.config.memoryDir, "daily");
      if (!result) return null;
      return { timestamp: result.timestamp, summary: result.content };
    } catch {
      return null;
    }
  }

  /** Get memory storage statistics for a given chat. */
  getCronInfo(): { heartbeatRunning: boolean; intervalMs: number; tasks: string[]; lastSleepAudit: string | null } {
    const auditDir = join(this.config.memoryDir, "sleep");
    let lastAudit: string | null = null;
    try {
      const files = readdirSync(auditDir).filter(f => f.startsWith("sleep_")).sort();
      if (files.length > 0) lastAudit = files[files.length - 1]!;
    } catch { /* no audit dir */ }

    return {
      heartbeatRunning: this.heartbeat !== null,
      intervalMs: this.heartbeat?.intervalMs ?? 0,
      tasks: this.heartbeat?.getTaskNames() ?? [],
      lastSleepAudit: lastAudit,
    };
  }

  getStats(chatId?: number): {
      totalMessages: number;
      extractedMemories: number;
      extractedByType: Record<string, number>;
      consolidationFiles: { daily: number; weekly: number; quarterly: number };
      ingestedDocuments: number;
      preservedKeywords: number;
      heartbeatRunning: boolean;
      dbSizeBytes: number;
    } | null {
      if (!this.db) return null;

      try {
        const chatFilter = chatId !== undefined;
        const chatWhere = chatFilter ? " WHERE chat_id = ?" : "";
        const chatParams = chatFilter ? [chatId] : [];

        const totalMessages = (this.db.prepare(
          `SELECT COUNT(*) as cnt FROM messages${chatWhere}`,
        ).get(...chatParams) as { cnt: number }).cnt;

        const extractedMemories = (this.db.prepare(
          `SELECT COUNT(*) as cnt FROM extracted_memories${chatWhere}`,
        ).get(...chatParams) as { cnt: number }).cnt;

        const typeRows = this.db.prepare(
          `SELECT memory_type, COUNT(*) as cnt FROM extracted_memories${chatWhere} GROUP BY memory_type`,
        ).all(...chatParams) as Array<{ memory_type: string; cnt: number }>;
        const extractedByType: Record<string, number> = {};
        for (const row of typeRows) {
          extractedByType[row.memory_type] = row.cnt;
        }

        // Count consolidation .md files on disk
        const consolidationFiles = { daily: 0, weekly: 0, quarterly: 0 };
        for (const tier of ["daily", "weekly", "quarterly"] as const) {
          try {
            const dir = join(this.config.memoryDir, tier);
            consolidationFiles[tier] = readdirSync(dir).filter((f) => f.endsWith(".md")).length;
          } catch { /* dir doesn't exist yet */ }
        }

        const ingestedDocuments = (this.db.prepare(
          `SELECT COUNT(*) as cnt FROM ingested_documents${chatWhere}`,
        ).get(...chatParams) as { cnt: number }).cnt;

        const preservedKeywords = (this.db.prepare(
          `SELECT COUNT(*) as cnt FROM extracted_memories${chatFilter ? " WHERE chat_id = ? AND preserve_original = 1" : " WHERE preserve_original = 1"}`,
        ).get(...chatParams) as { cnt: number }).cnt;

        let dbSizeBytes = 0;
        try {
          const pageCount = (this.db.pragma("page_count") as Array<{ page_count: number }>)[0]?.page_count ?? 0;
          const pageSize = (this.db.pragma("page_size") as Array<{ page_size: number }>)[0]?.page_size ?? 4096;
          dbSizeBytes = pageCount * pageSize;
        } catch { /* ignore */ }

        return {
          totalMessages,
          extractedMemories,
          extractedByType,
          consolidationFiles,
          ingestedDocuments,
          preservedKeywords,
          heartbeatRunning: this.heartbeat !== null,
          dbSizeBytes,
        };
      } catch (err) {
        logError(TAG, `Failed to get stats${chatId !== undefined ? ` for chat ${chatId}` : ""}`, err);
        return null;
      }
    }

  /**
   * Edit an existing extracted memory. Unified mutation path for all field updates.
   * Supports lookup by memory ID or platform message ID.
   */
  editMemory(params: EditMemoryParams): EditMemoryResult {
    if (!this.db) return { ok: false, error: "memory disabled" };

    try {
      // Resolve target memory IDs
      let targetIds: number[];
      if (params.memoryId != null) {
        targetIds = [params.memoryId];
      } else if (params.messageId != null && params.chatId != null) {
        const msg = this.db.prepare(
          "SELECT id FROM messages WHERE chat_id = ? AND platform_message_id = ?",
        ).get(params.chatId, params.messageId) as { id: number } | undefined;
        if (!msg) return { ok: false, error: "message not found" };
        const rows = this.db.prepare(
          "SELECT id FROM extracted_memories WHERE source_message_ids LIKE '%' || ? || '%'",
        ).all(String(msg.id)) as Array<{ id: number }>;
        if (rows.length === 0) return { ok: false, error: "no memories linked to this message" };
        targetIds = rows.map(r => r.id);
      } else {
        return { ok: false, error: "--memory-id or --message-id + --chat-id required" };
      }

      // Build SET clauses from provided fields
      const sets: string[] = [];
      const values: unknown[] = [];
      const fieldsUpdated: string[] = [];

      if (params.contentEn != null) { sets.push("content_en = ?"); values.push(params.contentEn.trim()); fieldsUpdated.push("content_en"); }
      if (params.contentOriginal != null) { sets.push("content_original = ?"); values.push(params.contentOriginal.trim()); fieldsUpdated.push("content_original"); }
      if (params.keyword !== undefined) { sets.push("preserved_keyword = ?"); values.push(params.keyword?.trim() || null); fieldsUpdated.push("keyword"); }
      if (params.memoryType != null) {
        const valid = new Set(["fact", "decision", "preference", "event"]);
        if (!valid.has(params.memoryType)) return { ok: false, error: "invalid memory_type" };
        sets.push("memory_type = ?"); values.push(params.memoryType); fieldsUpdated.push("memory_type");
      }
      if (params.emotionScore != null) { sets.push("emotion_score = ?"); values.push(clampEmotionScore(params.emotionScore)); fieldsUpdated.push("emotion_score"); }
      if (params.confidence != null) { sets.push("confidence = ?"); values.push(params.confidence); fieldsUpdated.push("confidence"); }
      if (params.trust != null) {
        if (params.trust < 0 || params.trust > 3) return { ok: false, error: "trust must be 0-3" };
        sets.push("trust = ?"); values.push(params.trust); fieldsUpdated.push("trust");
      }
      if (params.integrity != null) {
        if (params.integrity < 0 || params.integrity > 3) return { ok: false, error: "integrity must be 0-3" };
        sets.push("integrity = ?"); values.push(params.integrity); fieldsUpdated.push("integrity");
      }
      if (params.credibility != null) {
        if (params.credibility < 1 || params.credibility > 6) return { ok: false, error: "credibility must be 1-6" };
        sets.push("credibility = ?"); values.push(params.credibility); fieldsUpdated.push("credibility");
      }
      if (params.classification != null) {
        if (params.classification < 0 || params.classification > 3) return { ok: false, error: "classification must be 0-3" };
        fieldsUpdated.push("classification");
      }

      // Relevance: support relative (+N/-N) and absolute
      if (params.relevanceScore != null) {
        const raw = params.relevanceScore;
        if (typeof raw === "string" && /^[+-]\d+$/.test(raw)) {
          sets.push("relevance_score = relevance_score + ?"); values.push(parseInt(raw, 10));
        } else {
          sets.push("relevance_score = ?"); values.push(typeof raw === "string" ? parseInt(raw, 10) : raw);
        }
        fieldsUpdated.push("relevance_score");
      }

      if (sets.length === 0 && params.classification == null) return { ok: false, error: "no fields to update" };

      // Dry run: return what would change
      if (params.dryRun) {
        return { ok: true, memoriesUpdated: targetIds.length, ids: targetIds, fieldsUpdated };
      }

      // Apply edits per target
      const now = Date.now();
      const editedBy = params.caller ?? null;
      const contentChanged = params.contentEn != null;

      for (const id of targetIds) {
        // Classification guard: check per-memory
        if (params.classification != null) {
          const row = this.db.prepare("SELECT classification FROM extracted_memories WHERE id = ?").get(id) as { classification: number } | undefined;
          if (!row) continue;
          const oldLevel = row.classification;
          const newLevel = params.classification;
          // SECRET (3) can't be declassified without userOverride
          if (oldLevel === 3 && newLevel < 3 && !params.userOverride) {
            return { ok: false, error: "cannot declassify SECRET without --user-override" };
          }
          // CONFIDENTIAL (2) can only go to 1, not to 0
          if (oldLevel === 2 && newLevel < oldLevel && newLevel !== 1) {
            return { ok: false, error: "CONFIDENTIAL can only be declassified to RESTRICTED (1)" };
          }
        }

        // Verify memory exists
        const exists = this.db.prepare("SELECT id FROM extracted_memories WHERE id = ?").get(id);
        if (!exists) continue;

        // Build final SET with classification + audit fields
        const finalSets = [...sets];
        const finalValues = [...values];
        if (params.classification != null) { finalSets.push("classification = ?"); finalValues.push(params.classification); }
        finalSets.push("edited_at = ?", "edited_by = ?");
        finalValues.push(now, editedBy);

        // Null embedding if content changed
        if (contentChanged) { finalSets.push("embedding = NULL"); }

        finalValues.push(id);
        this.db.prepare(`UPDATE extracted_memories SET ${finalSets.join(", ")} WHERE id = ?`).run(...finalValues);

        // Re-embed if content changed
        if (contentChanged && params.contentEn) {
          this.embedNewMemory(params.contentEn.trim());
        }
      }

      logInfo(TAG, `editMemory: updated ${targetIds.length} memories [${fieldsUpdated.join(",")}] caller=${editedBy}`);
      return { ok: true, memoriesUpdated: targetIds.length, ids: targetIds, fieldsUpdated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(TAG, "editMemory failed", err);
      return { ok: false, error: message };
    }
  }

  /**
   * Immediately persist a memory from the agent's instant_store tool.
   * Validates inputs, inserts into extracted_memories, and advances the watermark.
   */
  async instantStore(params: InstantStoreParams): Promise<InstantStoreResult> {
    if (!this.db) {
      return { stored: false, memoriesCount: 0, error: "memory disabled" };
    }

    try {
      // Validate required string fields
      if (!params.contentEn || typeof params.contentEn !== "string" || params.contentEn.trim() === "") {
        return { stored: false, memoriesCount: 0, error: "content-en is required" };
      }
      if (!params.contentOriginal || typeof params.contentOriginal !== "string" || params.contentOriginal.trim() === "") {
        return { stored: false, memoriesCount: 0, error: "content-original is required" };
      }

      // Validate memory type
      const validTypes = new Set(["fact", "decision", "preference", "event"]);
      if (!validTypes.has(params.memoryType)) {
        return { stored: false, memoriesCount: 0, error: "invalid memory_type" };
      }

      // Clamp emotion score
      const emotionScore = clampEmotionScore(params.emotionScore);

      const now = Date.now();

      // Insert into extracted_memories with preserve_original = true
      this.db.prepare(
        `INSERT INTO extracted_memories
           (chat_id, content_original, content_en, memory_type, source_timestamp,
            preserve_original, preserved_keyword, emotion_score, created_at,
            confidence, source_message_ids, classification, trust, integrity, credibility)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.chatId,
        params.contentOriginal.trim(),
        params.contentEn.trim(),
        params.memoryType,
        now,
        1, // preserve_original = true
        params.keyword?.trim() || null,
        emotionScore,
        now,
        params.confidence ?? 3,
        params.sourceMessageIds?.trim() || null,
        params.classification ?? 1,
        params.trust ?? 0,
        params.integrity ?? 2,
        params.credibility ?? 6,
      );

      // NOTE: Do NOT advance watermark here — only sleep extraction should advance it.
      // Instant-store memories are ad-hoc; the extraction step still needs to scan
      // all messages since its last run to catch anything the main agent missed.

      // Embed for Se sidecar (async, non-blocking — failure is OK)
      this.embedNewMemory(params.contentEn.trim());

      logInfo(TAG, `Instant store: persisted memory for chat ${params.chatId} (type=${params.memoryType}, emotion=${emotionScore})`);
      return { stored: true, memoriesCount: 1 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(TAG, `Instant store failed for chat ${params.chatId}`, err);
      return { stored: false, memoriesCount: 0, error: message };
    }
  }

  /** Adjust relevance_score on an existing extracted memory (used by sleep feedback pass). */
  adjustRelevance(id: number, delta: number): void {
    this.editMemory({ memoryId: id, relevanceScore: `${delta >= 0 ? "+" : ""}${delta}` });
  }

  /**
   * Reclassify a memory's confidentiality level.
   * Restricted (3) is permanent — agent cannot lower it without userOverride.
   */
  reclassifyMemory(id: number, level: number, userOverride = false): { ok: boolean; error?: string } {
    return this.editMemory({ memoryId: id, classification: level, userOverride });
  }

  /** Merge two extracted memories: keep newer, combine Darwinism scores, delete older. */
  mergeMemories(idA: number, idB: number): { merged: boolean; keptId: number; deletedId: number } | { merged: false; error: string } {
    if (!this.db) return { merged: false, error: "memory disabled" };

    const rows = this.db.prepare(
      "SELECT id, recall_count, relevance_score, confidence, created_at FROM extracted_memories WHERE id IN (?, ?)",
    ).all(idA, idB) as Array<{ id: number; recall_count: number; relevance_score: number; confidence: number; created_at: number }>;

    if (rows.length !== 2) return { merged: false, error: "one or both IDs not found" };

    const [older, newer] = rows.sort((a, b) => a.created_at - b.created_at) as [typeof rows[0], typeof rows[0]];

    this.db.prepare(`
      UPDATE extracted_memories SET
        recall_count = recall_count + ?,
        relevance_score = MAX(relevance_score, ?),
        confidence = MAX(confidence, ?),
        integrity = 3
      WHERE id = ?
    `).run(older!.recall_count ?? 0, older!.relevance_score ?? 0, older!.confidence ?? 3, newer!.id);

    this.db.prepare("DELETE FROM extracted_memories WHERE id = ?").run(older!.id);

    // Re-embed the kept memory (its content may have changed context)
    const kept = this.db.prepare("SELECT content_en FROM extracted_memories WHERE id = ?").get(newer!.id) as { content_en: string } | undefined;
    if (kept) this.embedNewMemory(kept.content_en);

    return { merged: true, keptId: newer!.id, deletedId: older!.id };
  }

  /** Close the database connection. */
  close(): void {
    if (!this.db) return;

    try {
      this.stopHeartbeat();
      this.db.close();
      this.db = null;
      logInfo(TAG, "Memory manager closed");
    } catch (err) {
      logError(TAG, "Failed to close database", err);
    }
  }

  /** Embed a newly inserted memory (fire-and-forget). */
  private embedNewMemory(contentEn: string): void {
    const cfg = loadEmbedConfig();
    if (!cfg.enabled || !this.db) return;
    embedText(cfg, contentEn).then(vec => {
      if (!vec || !this.db) return;
      this.db.prepare(
        "UPDATE extracted_memories SET embedding = ? WHERE content_en = ? AND embedding IS NULL"
      ).run(Buffer.from(vec.buffer), contentEn);
    }).catch(() => {});
  }
}
