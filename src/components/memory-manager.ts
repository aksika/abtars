import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { VectorIndex } from "./vector-index.js";
import { EmbeddingProvider } from "./embedding-provider.js";
import { TranscriptWriter } from "./transcript-writer.js";
import { TranscriptParser } from "./transcript-parser.js";
import { ContextAssembler } from "./context-assembler.js";
import { HeartbeatSystem } from "./heartbeat-system.js";
import { MemorySearchTool } from "./memory-search-tool.js";
import type { MemorySearchToolConfig } from "./memory-search-tool.js";
import { IngestionPipeline } from "./ingestion-pipeline.js";
import { ReflectionEngine } from "./reflection-engine.js";
import { IntentDetector, DEFAULT_CUE_PHRASES_EN, DEFAULT_CUE_PHRASES_HU } from "./intent-detector.js";
import { RecallFallbackPipeline } from "./recall-fallback-pipeline.js";
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
  MemorySearchParams,
  MemorySearchResult,
  InstantStoreParams,
  InstantStoreResult,
} from "../types/index.js";
import { clampEmotionScore } from "./emotion-utils.js";
import { logError, logInfo, logWarn } from "./logger.js";

const TAG = "memory-manager";

/** Strip emoji characters from text. Emotion is captured via score, not glyphs. */
function stripEmojis(text: string): string {
  return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").replace(/ {2,}/g, " ").trim();
}

/**
 * Top-level coordinator for the local memory layer.
 *
 * Owns the SQLite database, transcript I/O, and FTS index.
 * When `memoryEnabled` is false, all methods are no-ops.
 * All public methods are wrapped in try/catch — they never throw.
 */
export class MemoryManager {
  private readonly config: MemoryConfig;
  private db: Database.Database | null = null;
  private memoryIndex: MemoryIndex | null = null;
  private vectorIndex: VectorIndex | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;
  private transcriptWriter: TranscriptWriter | null = null;
  private transcriptParser: TranscriptParser | null = null;
  private writeCounter: number = 0;
  private llmCall: ((prompt: string, content: string) => Promise<string>) | null = null;
  private ingestionPipeline: IngestionPipeline | null = null;
  private browserManager: import("./browser-manager.js").BrowserManager | null = null;
  private reflectionEngine: ReflectionEngine | null = null;
  private recallPipeline: RecallFallbackPipeline | null = null;
  private heartbeat: HeartbeatSystem | null = null;
  private contextAssembler: ContextAssembler | null = null;
  private memorySearchTool: MemorySearchTool | null = null;
  private compactionLocks = new Map<number, Promise<void>>();

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

  /** Acquire a per-chat compaction lock. Returns a release function, or null if already locked. */
  acquireCompactionLock(chatId: number): Promise<() => void> | null {
    if (this.compactionLocks.has(chatId)) return null;

    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.compactionLocks.set(chatId, promise);

    return Promise.resolve(() => {
      this.compactionLocks.delete(chatId);
      release();
    });
  }

  /** Initialize database, create directories, and set up sub-components. */
  async initialize(): Promise<void> {
    if (!this.config.memoryEnabled) return;

    try {
      mkdirSync(this.config.memoryDir, { recursive: true });
      mkdirSync(join(this.config.memoryDir, "transcripts"), { recursive: true });

      const dbPath = join(this.config.memoryDir, "memory.db");
      this.db = initializeDatabase(dbPath);

      // Idempotent migration: add emotion_score column if it doesn't exist
      try {
        this.db.exec("ALTER TABLE extracted_memories ADD COLUMN emotion_score INTEGER DEFAULT 0");
      } catch {
        // Column already exists — safe to ignore
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
      this.transcriptWriter = new TranscriptWriter(this.config.memoryDir);
      this.transcriptParser = new TranscriptParser();

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

      // Initialize recall fallback pipeline when enabled
      if (this.config.recallFallback.enabled) {
        let detectorConfig: { cuePhrasesEn: string[]; cuePhrasesHu: string[] } | undefined;
        if (this.config.recallFallback.cuePhrases) {
          try {
            const parsed = JSON.parse(this.config.recallFallback.cuePhrases);
            detectorConfig = {
              cuePhrasesEn: Array.isArray(parsed.en) ? parsed.en : [],
              cuePhrasesHu: Array.isArray(parsed.hu) ? parsed.hu : [],
            };
          } catch {
            logWarn(TAG, "Invalid cuePhrases JSON in recall fallback config — using defaults");
          }
        }
        const detector = new IntentDetector(
          detectorConfig ?? {
            cuePhrasesEn: [...DEFAULT_CUE_PHRASES_EN],
            cuePhrasesHu: [...DEFAULT_CUE_PHRASES_HU],
          },
        );
        this.recallPipeline = new RecallFallbackPipeline(this, detector, {
          enabled: true,
          timeoutMs: this.config.recallFallback.timeoutMs,
          contextMessages: this.config.recallFallback.contextMessages,
          minTokenLength: this.config.recallFallback.minTokenLength,
          vectorEnabled: this.config.vectorEnabled,
        });
        logInfo(TAG, "Recall fallback pipeline enabled");
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
   * Record a conversation message: append to transcript, index in FTS,
   * optionally index in vector store, enforce message limits, and
   * periodically enforce disk budget.
   *
   * When `memoryEnabled` is false, this is a no-op.
   * Never throws — all errors are caught and logged.
   */
  recordMessage(record: MessageRecord): void {
    if (!this.config.memoryEnabled || !this.db) return;

    try {
      // 1. Append to JSONL transcript (raw, with emojis for debug/audit)
      this.transcriptWriter?.append(record);

      // 2. Strip emojis before DB indexing — emotion is captured via score
      const cleaned = { ...record, content: stripEmojis(record.content) };

      // 2b. Skip empty content (e.g. pure emoji messages)
      if (!cleaned.content) return;

      // 3. Index in FTS (returns the inserted message id)
      if (!this.memoryIndex) return;
      const messageId = this.memoryIndex.index(cleaned);

      // 3b. Immutable backup copy (never touched by LLM/sleep)
      this.db.prepare(
        "INSERT INTO chat_backup (chat_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
      ).run(cleaned.chatId, cleaned.sessionId, cleaned.role, cleaned.content, cleaned.timestamp);

      // 4. Fire-and-forget vector indexing if available
      if (this.vectorIndex) {
        this.vectorIndex.index(messageId, cleaned.content).catch((err) =>
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

  /** Update emotion_score on a message identified by platform message ID. Returns true if updated. */
  updateEmotionByPlatformId(chatId: number, platformMessageId: number, score: number): boolean {
    if (!this.db) return false;
    try {
      const result = this.db.prepare(
        "UPDATE messages SET emotion_score = ? WHERE chat_id = ? AND platform_message_id = ?",
      ).run(score, chatId, platformMessageId);
      return result.changes > 0;
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

  /** Recall memories + core facts for prompt injection. Uses pipeline for keyword extraction. */
  async recallForPrompt(chatId: number, userInput: string, sessionId?: string): Promise<string> {
    if (!this.config.memoryEnabled) return "";
    const parts: string[] = [];
    try {
      // Core facts (always injected if non-empty)
      const facts = this.readCoreKnowledge();
      if (facts.trim()) parts.push(`[CORE KNOWLEDGE]\n${facts.trim()}`);

      // Recalled memories via pipeline (keyword extraction + intent detection)
      const workingMemory = sessionId
        ? this.loadRecentMessages(chatId, sessionId, 6)
        : [];
      let results: SearchResult[];
      if (this.recallPipeline) {
        const pr = await this.recallPipeline.execute(userInput, chatId, workingMemory, 3);
        results = pr.results;
      } else {
        results = await this.search(userInput, { chatId, limit: 3 });
      }
      if (results.length > 0) {
        const snippets = results.map(r => `- [${r.record.role}] ${r.record.content}`);
        parts.push(`[RECALLED MEMORIES]\n${snippets.join("\n")}`);
      }
    } catch { /* silent */ }
    return parts.join("\n\n");
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
   * Enforce disk budget by deleting oldest transcript files when total size exceeds budget.
   * Runs on startup and after every 100 recordMessage() calls.
   */
  enforceDiskBudget(): void {
    if (!this.config.memoryEnabled) return;

    try {
      const transcriptsDir = join(this.config.memoryDir, "transcripts");
      const dbPath = join(this.config.memoryDir, "memory.db");

      // 1. Collect all .jsonl files with their sizes and mtimes
      const files: Array<{ path: string; size: number; mtime: number; chatId: number; sessionId: string }> = [];

      if (existsSync(transcriptsDir)) {
        const chatDirs = readdirSync(transcriptsDir);
        for (const chatDir of chatDirs) {
          const chatPath = join(transcriptsDir, chatDir);
          let chatStat;
          try {
            chatStat = statSync(chatPath);
          } catch {
            continue;
          }
          if (!chatStat.isDirectory()) continue;

          const sessionFiles = readdirSync(chatPath);
          for (const sessionFile of sessionFiles) {
            if (!sessionFile.endsWith(".jsonl")) continue;

            const filePath = join(chatPath, sessionFile);
            let fileStat;
            try {
              fileStat = statSync(filePath);
            } catch {
              continue;
            }

            const chatId = Number(chatDir);
            const sessionId = sessionFile.replace(/\.jsonl$/, "");

            files.push({
              path: filePath,
              size: fileStat.size,
              mtime: fileStat.mtimeMs,
              chatId,
              sessionId,
            });
          }
        }
      }

      // 2. Calculate total size (transcripts + DB)
      let dbSize = 0;
      try {
        if (existsSync(dbPath)) {
          dbSize = statSync(dbPath).size;
        }
      } catch {
        // ignore stat errors on DB
      }

      let totalSize = dbSize;
      for (const f of files) {
        totalSize += f.size;
      }

      // 3. If under budget, nothing to do
      if (totalSize <= this.config.diskBudgetBytes) return;

      // 4. Sort by mtime ascending (oldest first)
      files.sort((a, b) => a.mtime - b.mtime);

      // 5. Delete oldest files until under budget
      for (const file of files) {
        if (totalSize <= this.config.diskBudgetBytes) break;

        try {
          unlinkSync(file.path);
          totalSize -= file.size;

          // Remove corresponding index entries
          if (this.memoryIndex) {
            this.memoryIndex.removeSession(file.chatId, file.sessionId);
          }
          if (this.vectorIndex) {
            this.vectorIndex.removeSession(file.chatId, file.sessionId);
          }

          logInfo(TAG, `Deleted transcript ${file.path} for disk budget enforcement`);
        } catch (deleteErr) {
          logWarn(TAG, `Failed to delete transcript ${file.path}: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`);
        }
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
    if (!this.config.memoryEnabled || !this.transcriptParser) return;

    const threshold = this.config.searchEnhancements.compactThresholdPct;
    if (params.contextPercent < threshold) return;

    logInfo(
      TAG,
      `Auto-compact triggered for chat ${params.chatId} session ${params.sessionId} (context ${params.contextPercent}% >= ${threshold}% threshold)`,
    );

    try {
      // Write raw transcript to working directory as safety net
      const transcriptPath = join(
        this.config.memoryDir,
        "transcripts",
        String(params.chatId),
        `${params.sessionId}.jsonl`,
      );

      if (existsSync(transcriptPath) && this.transcriptParser) {
        const messages = this.transcriptParser.parse(transcriptPath);
        if (messages.length > 0) {
          const dateStr = new Date().toISOString().slice(0, 10);
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
   * Load the most recent N messages from a session transcript.
   * Delegates to TranscriptParser.parseTail().
   * Returns empty array when memoryEnabled is false, file doesn't exist, or on error.
   */
  loadRecentMessages(chatId: number, sessionId: string, count: number): MessageRecord[] {
    if (!this.config.memoryEnabled || !this.transcriptParser) return [];

    try {
      const filePath = join(
        this.config.memoryDir,
        "transcripts",
        String(chatId),
        `${sessionId}.jsonl`,
      );

      if (!existsSync(filePath)) return [];

      return this.transcriptParser.parseTail(filePath, count);
    } catch (err) {
      logError(TAG, `Failed to load recent messages for chat ${chatId} session ${sessionId}`, err);
      return [];
    }
  }

  /**
   * Build assembled context for a user message. Called by transport before sending to LLM.
   * Delegates to ContextAssembler.assemble() with all five tiers
   * (soul/core facts, recalled memories, working memory, new input).
   * Falls back to raw userInput if assembly fails, logging a warning.
   * Returns the assembled context text as a string.
   */
  async assembleContext(params: {
    chatId: number;
    channelKey?: string;
    userInput: string;
    systemPrompt: string;
    workingMemory?: MessageRecord[];
    isSessionStart?: boolean;
  }): Promise<string> {
    if (!this.config.memoryEnabled) return params.userInput;

    try {
      // System prompt (SOUL.md + skills) is passed in from main.ts — no longer injected here.
      const systemPrompt = params.systemPrompt;

      if (!this.contextAssembler) {
        this.contextAssembler = new ContextAssembler(this, this.config);
      }
      const assembler = this.contextAssembler;
      if (this.recallPipeline) {
        assembler.setPipeline(this.recallPipeline);
      }
      if (this.llmCall) {
        assembler.setLlmCall(this.llmCall);
      }
      const result = await assembler.assemble({
        chatId: params.chatId,
        channelKey: params.channelKey ?? String(params.chatId),
        userInput: params.userInput,
        systemPrompt,
        workingMemory: params.workingMemory ?? [],
        isSessionStart: params.isSessionStart,
      });
      return result.text;
    } catch (err) {
      logWarn(TAG, `Context assembly failed for chat ${params.chatId}, falling back to raw user input: ${err instanceof Error ? err.message : String(err)}`);
      return params.userInput;
    }
  }



  /**
   * Cascade deletion through all storage layers for the given message IDs.
   *
   * Deletes from: embeddings table, FTS5 index (via trigger on messages delete),
   * messages table, compactions table + .md files on disk, and transcript JSONL files.
   *
   * Uses a transaction for the SQLite operations. File I/O errors are logged
   * but do not abort the operation — partial cleanup is acceptable.
   *
   * Returns a ForgetResult with counts from each layer.
   */
  private cascadeDelete(messageIds: number[], chatId: number): ForgetResult {
    const result: ForgetResult = {
      messagesRemoved: 0,
      embeddingsRemoved: 0,
      compactionsRemoved: 0,
      transcriptEntriesRemoved: 0,
    };

    if (!this.db || messageIds.length === 0) return result;

    try {
      // 1. Query messages to get session IDs and timestamps before deleting
      //    (needed for transcript cleanup and compaction lookup)
      const placeholders = messageIds.map(() => "?").join(",");
      const messageRows = this.db
        .prepare(
          `SELECT id, chat_id, session_id, timestamp, content FROM messages WHERE id IN (${placeholders})`,
        )
        .all(...messageIds) as Array<{
        id: number;
        chat_id: number;
        session_id: string;
        timestamp: number;
        content: string;
      }>;

      if (messageRows.length === 0) return result;

      // Collect unique session IDs and a set of (timestamp, content) for transcript matching
      const sessionIds = new Set<string>();
      const messageSignatures = new Set<string>();
      for (const row of messageRows) {
        sessionIds.add(row.session_id);
        messageSignatures.add(`${row.timestamp}:${row.content}`);
      }

      // 2. Delete from embeddings table
      const embeddingsResult = this.db
        .prepare(`DELETE FROM embeddings WHERE message_id IN (${placeholders})`)
        .run(...messageIds);
      result.embeddingsRemoved = embeddingsResult.changes;

      // 3. Delete from messages table (the AFTER DELETE trigger on messages
      //    automatically removes corresponding rows from messages_fts)
      const messagesResult = this.db
        .prepare(`DELETE FROM messages WHERE id IN (${placeholders})`)
        .run(...messageIds);
      result.messagesRemoved = messagesResult.changes;

      // 4. Delete related compactions and their .md files on disk
      const sessionPlaceholders = Array.from(sessionIds)
        .map(() => "?")
        .join(",");
      const compactionRows = this.db
        .prepare(
          `SELECT id, file_path FROM compactions WHERE chat_id = ? AND source_session_id IN (${sessionPlaceholders})`,
        )
        .all(chatId, ...sessionIds) as Array<{ id: number; file_path: string }>;

      if (compactionRows.length > 0) {
        const compactionIds = compactionRows.map((r) => r.id);
        const compactionPlaceholders = compactionIds.map(() => "?").join(",");
        const compactionsResult = this.db
          .prepare(`DELETE FROM compactions WHERE id IN (${compactionPlaceholders})`)
          .run(...compactionIds);
        result.compactionsRemoved = compactionsResult.changes;

        // Delete .md files on disk
        for (const row of compactionRows) {
          try {
            if (existsSync(row.file_path)) {
              unlinkSync(row.file_path);
            }
          } catch (fileErr) {
            logWarn(
              TAG,
              `Failed to delete compaction file ${row.file_path}: ${fileErr instanceof Error ? fileErr.message : String(fileErr)}`,
            );
          }
        }
      }

      // 5. Remove matching entries from transcript JSONL files
      if (this.transcriptWriter && this.transcriptParser) {
        for (const sessionId of sessionIds) {
          try {
            const transcriptPath = this.transcriptWriter.getPath(chatId, sessionId);
            if (!existsSync(transcriptPath)) continue;

            const allRecords = this.transcriptParser.parse(transcriptPath);
            const filtered = allRecords.filter(
              (r) => !messageSignatures.has(`${r.timestamp}:${r.content}`),
            );
            const removed = allRecords.length - filtered.length;

            if (removed > 0) {
              // Rewrite the file with remaining records
              const newContent = filtered.map((r) => JSON.stringify(r)).join("\n") + (filtered.length > 0 ? "\n" : "");
              writeFileSync(transcriptPath, newContent);
              result.transcriptEntriesRemoved += removed;
            }
          } catch (transcriptErr) {
            logWarn(
              TAG,
              `Failed to clean transcript for session ${sessionId}: ${transcriptErr instanceof Error ? transcriptErr.message : String(transcriptErr)}`,
            );
          }
        }
      }

      logInfo(
        TAG,
        `Cascade delete for chat ${chatId}: ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings, ${result.compactionsRemoved} compactions, ${result.transcriptEntriesRemoved} transcript entries`,
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
      compactionsRemoved: 0,
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

      if (result.compactionsRemoved > 0) {
        logInfo(
          TAG,
          `forgetTopic: ${result.compactionsRemoved} compactions removed for topic "${topic}". ` +
            `Full compaction regeneration excluding forgotten content is not yet implemented.`,
        );
      }

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
      compactionsRemoved: 0,
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

      if (result.compactionsRemoved > 0) {
        logInfo(
          TAG,
          `forgetRange: ${result.compactionsRemoved} compactions removed for date range. ` +
            `Full compaction regeneration excluding forgotten content is not yet implemented.`,
        );
      }

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
      compactionsRemoved: 0,
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

      if (result.compactionsRemoved > 0) {
        logInfo(
          TAG,
          `forgetSession: ${result.compactionsRemoved} compactions removed for session ${sessionId}. ` +
            `Full compaction regeneration excluding forgotten content is not yet implemented.`,
        );
      }

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
   * Creates HeartbeatSystem and MemorySearchTool.
   * Registers heartbeat tasks:
   *   - sleep-trigger: checks every 5min (≥8am, 10min idle, once/day)
   *
   * On failure, logs a warning and continues without background processing.
   */
  /** Initialize the MemorySearchTool (called from main.ts before heartbeat start). */
  initSearchTool(): void {
    if (!this.config.memoryEnabled || !this.db || !this.memoryIndex) return;
    const searchConfig: MemorySearchToolConfig = {
      searchTimeoutMs: this.config.searchEnhancements.searchTimeoutMs,
      decayHalflifeDays: this.config.searchEnhancements.decayHalflifeDays,
      mmrLambda: this.config.searchEnhancements.mmrLambda,
    };
    this.memorySearchTool = new MemorySearchTool(this.db, this.memoryIndex, searchConfig);
  }

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
  getLatestCompaction(chatId: number): { timestamp: number; summary: string } | null {
    if (!this.db) return null;
    try {
      const row = this.db
        .prepare(
          `SELECT timestamp, summary FROM compactions
           WHERE chat_id = ? AND tier = 'daily'
           ORDER BY timestamp DESC LIMIT 1`,
        )
        .get(chatId) as { timestamp: number; summary: string } | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  /** Get the memory search tool for agent invocation. */
  getMemorySearchTool(): MemorySearchTool | null {
    return this.memorySearchTool;
  }

  /**
   * Execute a memory search (delegates to MemorySearchTool).
   * Returns empty results on error for graceful degradation.
   */
  async memorySearch(params: MemorySearchParams, chatId: number): Promise<MemorySearchResult[]> {
    try {
      if (!this.memorySearchTool) return [];
      return await this.memorySearchTool.search(params, chatId);
    } catch (err) {
      logWarn(TAG, `Memory search failed for chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Get memory storage statistics for a given chat. */
  getCronInfo(): { heartbeatRunning: boolean; intervalMs: number; tasks: string[]; lastSleepAudit: string | null } {
    const auditDir = join(this.config.memoryDir, "audit");
    let lastAudit: string | null = null;
    try {
      const files = readdirSync(auditDir).filter(f => f.startsWith("sleep_")).sort();
      if (files.length > 0) lastAudit = files[files.length - 1]!;
    } catch { /* no audit dir */ }

    return {
      heartbeatRunning: this.heartbeat !== null,
      intervalMs: this.config.heartbeat.intervalMs,
      tasks: this.heartbeat?.getTaskNames() ?? [],
      lastSleepAudit: lastAudit,
    };
  }

  getStats(chatId?: number): {
      totalMessages: number;
      extractedMemories: number;
      extractedByType: Record<string, number>;
      compactions: { daily: number; weekly: number; quarterly: number };
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

        const compactionRows = this.db.prepare(
          `SELECT tier, COUNT(*) as cnt FROM compactions${chatWhere} GROUP BY tier`,
        ).all(...chatParams) as Array<{ tier: string; cnt: number }>;
        const compactionCounts = { daily: 0, weekly: 0, quarterly: 0 };
        for (const row of compactionRows) {
          if (row.tier in compactionCounts) {
            compactionCounts[row.tier as keyof typeof compactionCounts] = row.cnt;
          }
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
          compactions: compactionCounts,
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
            preserve_original, preserved_keyword, emotion_score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );

      // Advance watermark to prevent heartbeat re-extraction
      this.db.prepare(
        `INSERT INTO extraction_watermarks (chat_id, last_processed_timestamp)
         VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET last_processed_timestamp = excluded.last_processed_timestamp`,
      ).run(params.chatId, now);

      logInfo(TAG, `Instant store: persisted memory for chat ${params.chatId} (type=${params.memoryType}, emotion=${emotionScore})`);
      return { stored: true, memoriesCount: 1 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(TAG, `Instant store failed for chat ${params.chatId}`, err);
      return { stored: false, memoriesCount: 0, error: message };
    }
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
}
