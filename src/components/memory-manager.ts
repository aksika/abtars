import { mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { MessageStore } from "./message-store.js";
import { MemoryEditor } from "./memory-editor.js";
import { MaintenanceService } from "./maintenance-service.js";
import { loadEmbedConfig } from "./ollama-embed.js";
import { HeartbeatSystem } from "./heartbeat-system.js";
import { getLatestConsolidationFile } from "./consolidation-search.js";
import type { SearchResult, SearchOptions } from "../types/index.js";
import { logError, logInfo, logWarn } from "./logger.js";

const TAG = "memory-manager";

/**
 * Top-level coordinator for the local memory layer.
 *
 * Owns the SQLite database and delegates to focused sub-services:
 * - store: message recording and loading
 * - editor: extracted memory mutations (edit, instant-store, merge, delete)
 * - maintenance: disk budget, backup pruning, auto-compact, forget operations
 *
 * When `memoryEnabled` is false, all methods are no-ops.
 */
export class MemoryManager {
  private readonly config: MemoryConfig;
  private db: Database.Database | null = null;
  private memoryIndex: MemoryIndex | null = null;
  private llmCall: ((prompt: string, content: string) => Promise<string>) | null = null;
  private heartbeat: HeartbeatSystem | null = null;

  /** Message recording and loading. Available after initialize(). */
  store!: MessageStore;
  /** Extracted memory mutations. Available after initialize(). */
  editor!: MemoryEditor;
  /** Disk budget, pruning, forget operations. Available after initialize(). */
  maintenance!: MaintenanceService;

  constructor(config: MemoryConfig) {
    this.config = config;
  }

  setLlmCall(llmCall: (prompt: string, content: string) => Promise<string>): void {
    this.llmCall = llmCall;
  }

  getLlmCall(): ((prompt: string, content: string) => Promise<string>) | null {
    return this.llmCall;
  }

  getMemoryIndex(): MemoryIndex | null { return this.memoryIndex; }
  getDatabase(): Database.Database | null { return this.db; }
  getDb(): Database.Database | null { return this.db; }
  getConfig(): MemoryConfig { return this.config; }

  async initialize(opts?: { skipEmbeddingCheck?: boolean }): Promise<void> {
    if (!this.config.memoryEnabled) return;

    try {
      mkdirSync(this.config.memoryDir, { recursive: true });

      const dbPath = join(this.config.memoryDir, "memory.db");
      this.db = initializeDatabase(dbPath);

      this.memoryIndex = new MemoryIndex(this.db);

      // Wire sub-services
      this.editor = new MemoryEditor(this.db);
      this.store = new MessageStore(this.db, this.config, this.memoryIndex);
      this.maintenance = new MaintenanceService(this.db, this.config, this.memoryIndex, this.editor);
      this.store.setDiskBudgetCallback(() => this.maintenance.enforceDiskBudget());

      // Ollama embedding health check (skip for CLI tools that just need DB access)
      if (!opts?.skipEmbeddingCheck) {
        const embedConfig = loadEmbedConfig();
        if (embedConfig.enabled) {
          try {
            const res = await fetch(`${embedConfig.url}/api/tags`);
            if (res.ok) {
              const data = await res.json() as { models?: Array<{ name: string }> };
              const models = data.models?.map(m => m.name) ?? [];
              if (models.some(m => m.startsWith(embedConfig.model))) {
                logInfo(TAG, `Embedding enabled: ${embedConfig.model} via ollama (Se sidecar ready)`);
              } else {
                logWarn(TAG, `Embedding model '${embedConfig.model}' not found in ollama (available: ${models.join(", ")})`);
              }
            } else {
              logWarn(TAG, `Ollama health check failed (HTTP ${res.status})`);
            }
          } catch {
            logWarn(TAG, `Ollama unreachable at ${embedConfig.url} — Se sidecar disabled`);
          }
        }
      }

      logInfo(TAG, "Memory manager initialized");
      this.maintenance.enforceDiskBudget();
      this.maintenance.pruneBackup();
    } catch (err) {
      logError(TAG, "Failed to initialize memory manager", err);
    }
  }

  // --- Delegated methods (kept for backward compat during migration) ---

  /** Record a conversation message. Delegates to store. */
  recordMessage(...args: Parameters<MessageStore["recordMessage"]>): void {
    if (!this.config.memoryEnabled || !this.store) return;
    this.store.recordMessage(...args);
  }

  /** Load recent messages. Delegates to store. */
  loadRecentMessages(chatId: number, sessionId: string, count: number): import("../types/index.js").MessageRecord[] {
    if (!this.config.memoryEnabled || !this.store) return [];
    return this.store.loadRecentMessages(chatId, sessionId, count);
  }

  /** Update emotion by platform message ID. Delegates to store + editor. */
  updateEmotionByPlatformId(chatId: number | string, platformMessageId: number, score: number): boolean {
    if (!this.store) return false;
    return this.store.updateEmotionByPlatformId(chatId, platformMessageId, score, (p) => this.editor.editMemory(p));
  }

  /** Search via FTS5. */
  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    if (!this.config.memoryEnabled || !this.memoryIndex) return [];
    try { return this.memoryIndex.search(query, opts); }
    catch (err) { logError(TAG, "Search failed", err); return []; }
  }

  /** Substring search via LIKE. */
  substringSearch(query: string, opts?: SearchOptions): SearchResult[] {
    if (!this.config.memoryEnabled || !this.memoryIndex) return [];
    try { return this.memoryIndex.substringSearch(query, opts); }
    catch (err) { logError(TAG, "Substring search failed", err); return []; }
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
      } catch (err) { logError(TAG, `Failed to read core/${file}`, err); }
    }
    return parts.join("\n\n");
  }

  /** Get the latest daily compaction for session-start injection. */
  getLatestCompaction(_chatId: number): { timestamp: number; summary: string } | null {
    try {
      const result = getLatestConsolidationFile(this.config.memoryDir, "daily");
      if (!result) return null;
      return { timestamp: result.timestamp, summary: result.content };
    } catch { return null; }
  }

  setHeartbeat(hb: HeartbeatSystem): void { this.heartbeat = hb; }
  stopHeartbeat(): void { this.heartbeat?.stop(); this.heartbeat = null; }

  getCronInfo(): { heartbeatRunning: boolean; intervalMs: number; tasks: string[]; lastSleepAudit: string | null } {
    const auditDir = join(this.config.memoryDir, "sleep");
    let lastAudit: string | null = null;
    try {
      const files = readdirSync(auditDir).filter(f => f.startsWith("sleep_")).sort();
      if (files.length > 0) lastAudit = files[files.length - 1]!;
    } catch { /* */ }
    return {
      heartbeatRunning: this.heartbeat !== null,
      intervalMs: this.heartbeat?.intervalMs ?? 0,
      tasks: this.heartbeat?.getTaskNames() ?? [],
      lastSleepAudit: lastAudit,
    };
  }

  getStats(chatId?: number): {
    totalMessages: number; extractedMemories: number; extractedByType: Record<string, number>;
    consolidationFiles: { daily: number; weekly: number; quarterly: number };
    ingestedDocuments: number; preservedKeywords: number; heartbeatRunning: boolean; dbSizeBytes: number;
  } | null {
    if (!this.db) return null;
    try {
      const cw = chatId !== undefined ? " WHERE chat_id = ?" : "";
      const cp = chatId !== undefined ? [chatId] : [];

      const totalMessages = (this.db.prepare(`SELECT COUNT(*) as cnt FROM messages${cw}`).get(...cp) as { cnt: number }).cnt;
      const extractedMemories = (this.db.prepare(`SELECT COUNT(*) as cnt FROM extracted_memories${cw}`).get(...cp) as { cnt: number }).cnt;

      const typeRows = this.db.prepare(`SELECT memory_type, COUNT(*) as cnt FROM extracted_memories${cw} GROUP BY memory_type`).all(...cp) as Array<{ memory_type: string; cnt: number }>;
      const extractedByType: Record<string, number> = {};
      for (const row of typeRows) extractedByType[row.memory_type] = row.cnt;

      const consolidationFiles = { daily: 0, weekly: 0, quarterly: 0 };
      for (const tier of ["daily", "weekly", "quarterly"] as const) {
        try { consolidationFiles[tier] = readdirSync(join(this.config.memoryDir, tier)).filter(f => f.endsWith(".md")).length; } catch { /* */ }
      }

      const ingestedDocuments = (this.db.prepare(`SELECT COUNT(*) as cnt FROM ingested_documents${cw}`).get(...cp) as { cnt: number }).cnt;
      const preservedKeywords = (this.db.prepare(
        `SELECT COUNT(*) as cnt FROM extracted_memories${chatId !== undefined ? " WHERE chat_id = ? AND preserve_original = 1" : " WHERE preserve_original = 1"}`,
      ).get(...cp) as { cnt: number }).cnt;

      let dbSizeBytes = 0;
      try {
        const pageCount = (this.db.pragma("page_count") as Array<{ page_count: number }>)[0]?.page_count ?? 0;
        const pageSize = (this.db.pragma("page_size") as Array<{ page_size: number }>)[0]?.page_size ?? 4096;
        dbSizeBytes = pageCount * pageSize;
      } catch { /* */ }

      return { totalMessages, extractedMemories, extractedByType, consolidationFiles, ingestedDocuments, preservedKeywords, heartbeatRunning: this.heartbeat !== null, dbSizeBytes };
    } catch (err) {
      logError(TAG, "Failed to get stats", err);
      return null;
    }
  }

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
