import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { VectorIndex } from "./vector-index.js";
import { EmbeddingProvider } from "./embedding-provider.js";
import { HeartbeatSystem } from "./heartbeat-system.js";
import { getLatestConsolidationFile } from "./consolidation-search.js";
import { loadEmbedConfig, embedText } from "./ollama-embed.js";
import { IngestionPipeline } from "./ingestion-pipeline.js";
import { ReflectionEngine } from "./reflection-engine.js";
import type {
  MessageRecord,
  SessionState,
  StoredSession,
  SearchResult,
  SearchOptions,
  IngestionSource,
  IngestionResult,
  IngestedDocument,
  Reflection,
  ForgetResult,
  InstantStoreParams,
  InstantStoreResult,
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
  private vectorIndex: VectorIndex | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;
  private writeCounter: number = 0;
  private llmCall: ((prompt: string, content: string) => Promise<string>) | null = null;
  private ingestionPipeline: IngestionPipeline | null = null;
  private browserManager: import("./browser-manager.js").BrowserManager | null = null;
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
  setBrowserManager(bm: import("./browser-manager.js").BrowserManager): void {
    this.browserManager = bm;
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

      // Optionally initialize vector search
      if (this.config.vectorEnabled) {
        this.embeddingProvider = new EmbeddingProvider();
        await this.embeddingProvider.initialize();
        if (this.embeddingProvider.isReady) {
          this.vectorIndex = new VectorIndex(this.db, this.embeddingProvider);
          logInfo(TAG, "Vector search enabled");

          // Initialize ingestion pipeline when vector search is available
          this.ingestionPipeline = new IngestionPipeline(
            this.db,
            this.embeddingProvider,
            this.vectorIndex,
            this.config,
            this.browserManager ?? undefined,
          );
          logInfo(TAG, "Ingestion pipeline enabled");
        } else {
          logWarn(TAG, "Embedding model not available — vector search disabled");
          this.embeddingProvider = null;
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
      const messageId = this.memoryIndex.index(record);

      // 2. Immutable backup copy (debug-only — controlled by DEBUG_MODE env var)
      if (process.env["DEBUG_MODE"] === "true" || process.env["DEBUG_MODE"] === "1") {
        this.db.prepare(
          "INSERT INTO chat_backup (chat_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
        ).run(record.chatId, record.sessionId, record.role, record.content, record.timestamp);
      }

      // 3. Fire-and-forget vector indexing if available
      if (this.vectorIndex) {
        this.vectorIndex.index(messageId, record.content).catch((err) =>
          logError(TAG, "Vector indexing failed", err),
        );
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
  updateEmotionByPlatformId(chatId: number, platformMessageId: number, score: number): boolean {
    if (!this.db) return false;
    try {
      const result = this.db.prepare(
        "UPDATE messages SET emotion_score = ? WHERE chat_id = ? AND platform_message_id = ?",
      ).run(score, chatId, platformMessageId);
      if (result.changes === 0) return false;

      // Propagate to extracted_memories that reference this message
      const msg = this.db.prepare(
        "SELECT id FROM messages WHERE chat_id = ? AND platform_message_id = ?",
      ).get(chatId, platformMessageId) as { id: number } | undefined;
      if (msg) {
        // source_message_ids is a JSON array of message IDs, e.g. "[1,2,3]"
        this.db.prepare(
          `UPDATE extracted_memories SET emotion_score = ?
           WHERE source_message_ids LIKE '%' || ? || '%'`,
        ).run(score, String(msg.id));
      }
      return true;
    } catch (err) {
      logError(TAG, "Failed to update emotion score", err);
      return false;
    }
  }


  /**
   * Combine FTS and vector search results using reciprocal rank fusion.
   * When vector search is disabled, returns FTS results only.
   */
  async hybridSearch(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    if (!this.config.memoryEnabled || !this.memoryIndex) return [];

    try {
      // 1. Get FTS results
      const ftsResults = this.memoryIndex.search(query, opts);

      // 2. If vector search is not available, return FTS results only
      if (!this.vectorIndex || !this.embeddingProvider?.isReady) {
        return ftsResults;
      }

      // 3. Get vector results
      const vectorResults = await this.vectorIndex.search(query, {
        chatId: opts?.chatId,
        limit: opts?.limit ?? 20,
      });

      // 4. Build rank maps (1-indexed ranks)
      const k = 60;
      const ftsRankMap = new Map<number, number>(); // messageId → rank
      // We need message IDs from FTS results — re-query to get them
      const ftsMessageIds = this.getFtsMessageIds(ftsResults);
      for (let i = 0; i < ftsMessageIds.length; i++) {
        ftsRankMap.set(ftsMessageIds[i]!, i + 1);
      }

      const vectorRankMap = new Map<number, number>();
      for (let i = 0; i < vectorResults.length; i++) {
        vectorRankMap.set(vectorResults[i]!.messageId, i + 1);
      }

      // 5. Collect all unique message IDs
      const allIds = new Set<number>([...ftsRankMap.keys(), ...vectorRankMap.keys()]);

      // 6. Compute RRF scores
      const scored: Array<{ messageId: number; score: number }> = [];
      for (const id of allIds) {
        const ftsRank = ftsRankMap.get(id);
        const vecRank = vectorRankMap.get(id);
        let score = 0;
        if (ftsRank !== undefined) score += 1 / (k + ftsRank);
        if (vecRank !== undefined) score += 1 / (k + vecRank);
        scored.push({ messageId: id, score });
      }

      // 7. Sort by descending fused score
      scored.sort((a, b) => b.score - a.score);

      // 8. Map back to SearchResult format
      const limit = opts?.limit ?? 20;
      const ftsResultMap = new Map<string, SearchResult>();
      for (const r of ftsResults) {
        const key = `${r.record.chatId}:${r.record.sessionId}:${r.record.timestamp}`;
        ftsResultMap.set(key, r);
      }

      const results: SearchResult[] = [];
      for (const item of scored.slice(0, limit)) {
        // Try to find the matching FTS result first
        const ftsMatch = ftsResults.find((_, idx) => ftsMessageIds[idx] === item.messageId);
        if (ftsMatch) {
          results.push({ record: ftsMatch.record, score: item.score });
        } else {
          // Load from DB for vector-only results
          const row = this.db
            ?.prepare(
              "SELECT chat_id, session_id, role, content, timestamp FROM messages WHERE id = ?",
            )
            .get(item.messageId) as
            | {
                chat_id: number;
                session_id: string;
                role: string;
                content: string;
                timestamp: number;
              }
            | undefined;
          if (row) {
            results.push({
              record: {
                role: row.role as "user" | "assistant" | "compaction",
                content: row.content,
                timestamp: row.timestamp,
                chatId: row.chat_id,
                sessionId: row.session_id,
              },
              score: item.score,
            });
          }
        }
      }

      return results;
    } catch (err) {
      logError(TAG, "Hybrid search failed", err);
      return [];
    }
  }

  /** Search conversation history (delegates to hybridSearch). */
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    return this.hybridSearch(query, opts);
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

  /**
   * Get message IDs corresponding to FTS search results.
   * Looks up by matching chat_id, session_id, role, and timestamp.
   */
  private getFtsMessageIds(results: SearchResult[]): number[] {
    if (!this.db || results.length === 0) return [];

    const stmt = this.db.prepare(
      `SELECT id FROM messages
       WHERE chat_id = ? AND session_id = ? AND role = ? AND timestamp = ?
       LIMIT 1`,
    );

    return results.map((r) => {
      const row = stmt.get(
        r.record.chatId,
        r.record.sessionId,
        r.record.role,
        r.record.timestamp,
      ) as { id: number } | undefined;
      return row?.id ?? -1;
    });
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

  /** Ingest an external document via the IngestionPipeline. */
  async ingestDocument(source: IngestionSource, chatId: number): Promise<IngestionResult> {
    if (!this.ingestionPipeline) {
      throw new Error("Ingestion pipeline is not available — vector search must be enabled.");
    }
    return this.ingestionPipeline.ingest(source, chatId);
  }

  /** List previously ingested documents, optionally filtered by chatId. */
  listIngestedDocuments(chatId?: number): IngestedDocument[] {
    if (!this.ingestionPipeline) {
      return [];
    }
    return this.ingestionPipeline.listIngested(chatId);
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
   * Re-embed all stored content with the current embedding model.
   * Delegates to EmbeddingProvider.reembed() and passes through the onProgress callback.
   */
  async reembed(onProgress: (processed: number, total: number) => void): Promise<void> {
    if (!this.embeddingProvider || !this.db) {
      throw new Error("Embedding provider is not available — vector search must be enabled.");
    }
    return this.embeddingProvider.reembed({ db: this.db, onProgress });
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
      const searchResults = await this.hybridSearch(topic, { chatId, limit: 100 });

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

      // Advance watermark to prevent heartbeat re-extraction
      this.db.prepare(
        `INSERT INTO extraction_watermarks (chat_id, last_processed_timestamp)
         VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET last_processed_timestamp = excluded.last_processed_timestamp`,
      ).run(params.chatId, now);

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
    if (!this.db) return;
    this.db.prepare(
      "UPDATE extracted_memories SET relevance_score = relevance_score + ? WHERE id = ?",
    ).run(delta, id);
  }

  /**
   * Reclassify a memory's confidentiality level.
   * Restricted (3) is permanent — agent cannot lower it without userOverride.
   */
  reclassifyMemory(id: number, level: number, userOverride = false): { ok: boolean; error?: string } {
    if (!this.db) return { ok: false, error: "memory disabled" };
    if (level < 0 || level > 3) return { ok: false, error: "classification must be 0-3" };

    const row = this.db.prepare("SELECT classification FROM extracted_memories WHERE id = ?").get(id) as { classification: number } | undefined;
    if (!row) return { ok: false, error: "memory not found" };

    if (row.classification === 3 && level < 3 && !userOverride) {
      return { ok: false, error: "cannot declassify restricted memory without --user-override" };
    }

    this.db.prepare("UPDATE extracted_memories SET classification = ? WHERE id = ?").run(level, id);
    return { ok: true };
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
