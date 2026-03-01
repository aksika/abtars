import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { VectorIndex } from "./vector-index.js";
import { EmbeddingProvider } from "./embedding-provider.js";
import { TranscriptWriter } from "./transcript-writer.js";
import { TranscriptParser } from "./transcript-parser.js";
import { CompactionEngine } from "./compaction-engine.js";
import { SleepCycleRunner } from "./sleep-cycle-runner.js";
import { ContextAssembler } from "./context-assembler.js";
import type {
  MessageRecord,
  SessionState,
  StoredSession,
  SearchResult,
  SearchOptions,
  CompactedMemory,
  AssembledContext,
} from "../types/index.js";
import { logError, logInfo, logWarn } from "./logger.js";

const TAG = "memory-manager";

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

  constructor(config: MemoryConfig) {
    this.config = config;
  }

  /** Initialize database, create directories, and set up sub-components. */
  async initialize(): Promise<void> {
    if (!this.config.memoryEnabled) return;

    try {
      mkdirSync(this.config.memoryDir, { recursive: true });
      mkdirSync(join(this.config.memoryDir, "transcripts"), { recursive: true });

      const dbPath = join(this.config.memoryDir, "memory.db");
      this.db = initializeDatabase(dbPath);
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
        } else {
          logWarn(TAG, "Embedding model not available — vector search disabled");
          this.embeddingProvider = null;
        }
      }

      logInfo(TAG, "Memory manager initialized");

      // Run disk budget enforcement on startup
      this.enforceDiskBudget();
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
      // 1. Append to JSONL transcript
      this.transcriptWriter?.append(record);

      // 2. Index in FTS (returns the inserted message id)
      if (!this.memoryIndex) return;
      const messageId = this.memoryIndex.index(record);

      // 3. Fire-and-forget vector indexing if available
      if (this.vectorIndex) {
        this.vectorIndex.index(messageId, record.content).catch((err) =>
          logError(TAG, "Vector indexing failed", err),
        );
      }

      // 4. Prune if chat exceeds maxMessagesPerChat
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

  /** Read the scratchpad for a chat. Creates empty file if not exists. */
  readScratchpad(chatId: number): string {
    if (!this.config.memoryEnabled) return "";

    try {
      const dir = join(this.config.memoryDir, "scratchpads", String(chatId));
      const filePath = join(dir, "scratchpad.md");

      if (!existsSync(filePath)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, "", "utf-8");
        return "";
      }

      return readFileSync(filePath, "utf-8");
    } catch (err) {
      logError(TAG, `Failed to read scratchpad for chat ${chatId}`, err);
      return "";
    }
  }

  /** Write to the scratchpad for a chat. */
  writeScratchpad(chatId: number, content: string): void {
    if (!this.config.memoryEnabled) return;

    try {
      const dir = join(this.config.memoryDir, "scratchpads", String(chatId));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "scratchpad.md"), content, "utf-8");
    } catch (err) {
      logError(TAG, `Failed to write scratchpad for chat ${chatId}`, err);
    }
  }

  /** Read user core facts for a chat. Creates empty file if not exists. */
  readUserCoreFacts(chatId: number): string {
    if (!this.config.memoryEnabled) return "";

    try {
      const dir = join(this.config.memoryDir, "core", String(chatId));
      const filePath = join(dir, "user_core_facts.md");

      if (!existsSync(filePath)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, "", "utf-8");
        return "";
      }

      return readFileSync(filePath, "utf-8");
    } catch (err) {
      logError(TAG, `Failed to read user core facts for chat ${chatId}`, err);
      return "";
    }
  }

  /**
   * Enforce the configured disk budget by deleting the oldest transcript files
   * when total usage exceeds the limit. Also removes corresponding index entries.
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
   * delegates to CompactionEngine.compact() which handles writing the daily
   * file, indexing in FTS, and persisting to the compactions table.
   *
   * On LLM failure, logs error and continues without compacting.
   * When memoryEnabled is false, this is a no-op.
   * Never throws.
   */
  async checkAutoCompact(params: {
    chatId: number;
    sessionId: string;
    llmCall: (prompt: string, content: string) => Promise<string>;
  }): Promise<void> {
    if (!this.config.memoryEnabled || !this.transcriptParser) return;

    try {
      const transcriptPath = join(
        this.config.memoryDir,
        "transcripts",
        String(params.chatId),
        `${params.sessionId}.jsonl`,
      );

      if (!existsSync(transcriptPath)) return;

      const messages = this.transcriptParser.parse(transcriptPath);
      if (messages.length === 0) return;

      const totalTokens = messages.reduce(
        (sum, m) => sum + Math.ceil(m.content.length / 4),
        0,
      );

      if (totalTokens <= this.config.autoCompactThreshold) return;

      logInfo(
        TAG,
        `Auto-compact triggered for chat ${params.chatId} session ${params.sessionId} (${totalTokens} tokens > ${this.config.autoCompactThreshold} threshold)`,
      );

      if (!this.db || !this.memoryIndex) return;

      const engine = new CompactionEngine(
        this.db,
        this.transcriptParser,
        this.memoryIndex,
        this.config,
      );

      await engine.compact({
        chatId: params.chatId,
        sessionId: params.sessionId,
        llmCall: params.llmCall,
      });
    } catch (err) {
      logError(TAG, "Auto-compact check failed", err);
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
   * Compact the current session into a daily memory snapshot.
   * Delegates to CompactionEngine.compact().
   * Returns null when memoryEnabled is false or on error.
   */
  async compactSession(params: {
    chatId: number;
    sessionId: string;
    llmCall: (prompt: string, content: string) => Promise<string>;
  }): Promise<CompactedMemory | null> {
    if (!this.config.memoryEnabled || !this.db || !this.transcriptParser || !this.memoryIndex) {
      return null;
    }

    try {
      const engine = new CompactionEngine(
        this.db,
        this.transcriptParser,
        this.memoryIndex,
        this.config,
      );

      return await engine.compact(params);
    } catch (err) {
      logError(TAG, `Failed to compact session for chat ${params.chatId}`, err);
      return null;
    }
  }

  /**
   * Run pending sleep cycle consolidations for a chat.
   * Creates a CompactionEngine and SleepCycleRunner, then delegates.
   * No-op when memoryEnabled is false. Never throws.
   */
  async runConsolidation(params: {
    chatId: number;
    llmCall: (prompt: string, content: string) => Promise<string>;
  }): Promise<void> {
    if (!this.config.memoryEnabled || !this.db || !this.transcriptParser || !this.memoryIndex) {
      return;
    }

    try {
      const engine = new CompactionEngine(
        this.db,
        this.transcriptParser,
        this.memoryIndex,
        this.config,
      );
      const runner = new SleepCycleRunner(engine, this.config);

      await runner.runPendingConsolidations(params);
    } catch (err) {
      logError(TAG, `Failed to run consolidation for chat ${params.chatId}`, err);
    }
  }

  /**
   * Assemble the full context for an LLM call.
   * Creates a ContextAssembler and delegates to assembler.assemble().
   * Returns a default empty AssembledContext on error or when memoryEnabled is false.
   */
  async assembleContext(params: {
    chatId: number;
    userInput: string;
    systemPrompt: string;
    workingMemory: MessageRecord[];
  }): Promise<AssembledContext> {
    const emptyContext: AssembledContext = {
      text: "",
      usage: { soul: 0, scratchpad: 0, recalled: 0, working: 0, input: 0, total: 0 },
    };

    if (!this.config.memoryEnabled) return emptyContext;

    try {
      const assembler = new ContextAssembler(this, this.config);
      return await assembler.assemble(params);
    } catch (err) {
      logError(TAG, `Failed to assemble context for chat ${params.chatId}`, err);
      return emptyContext;
    }
  }

  /** Close the database connection. */
  close(): void {
    if (!this.db) return;

    try {
      this.db.close();
      this.db = null;
      logInfo(TAG, "Memory manager closed");
    } catch (err) {
      logError(TAG, "Failed to close database", err);
    }
  }
}
