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
import type { IHeartbeat } from "./imemory-system.js";
import { getLatestConsolidationFile } from "./consolidation-search.js";
import type { SearchResult, SearchOptions } from "./mem-types.js";
import { logError, logInfo, logWarn } from "./mem-logger.js";

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
  private heartbeat: IHeartbeat | null = null;

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
  /** @deprecated Use sub-service methods (store, editor, maintenance) instead of raw DB access. */
  getDatabase(): Database.Database | null { return this.db; }
  /** @deprecated Use sub-service methods (store, editor, maintenance) instead of raw DB access. */
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

  /** Timestamp of the most recent message. */
  getLastMessageTimestamp(excludeSystem = false): number {
    return this.store?.getLastMessageTimestamp(excludeSystem) ?? 0;
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

  setHeartbeat(hb: IHeartbeat): void { this.heartbeat = hb; }
  stopHeartbeat(): void { this.heartbeat?.stop(); this.heartbeat = null; }

  getCronInfo(): { heartbeatRunning: boolean; intervalMs: number; tasks: string[]; taskStatuses: ReadonlyMap<string, string>; lastSleepAudit: string | null } {
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
      taskStatuses: this.heartbeat?.getTaskStatuses() ?? new Map(),
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

  // ── Dashboard / recall ──────────────────────────────────────────────────

  getDistinctChatIds(): number[] {
    return this.store?.getDistinctChatIds() ?? [];
  }

  getAllExtractedMemories(): unknown[] {
    return this.store?.getAllExtractedMemories() ?? [];
  }

  getAllEntities(): unknown[] {
    return this.store?.getAllEntities() ?? [];
  }

  getAllEntityLinks(): unknown[] {
    return this.store?.getAllEntityLinks() ?? [];
  }

  async recallSearch(params: import("./recall-engine.js").RecallParams): Promise<import("./recall-engine.js").RecallResult> {
    if (!this.db || !this.memoryIndex) throw new Error("Memory not initialized");
    const { recallSearch } = await import("./recall-engine.js");
    return recallSearch({ db: this.db, index: this.memoryIndex, memoryDir: this.config.memoryDir }, params);
  }

  bumpRecallCount(ids: number[]): void {
    this.memoryIndex?.bumpRecallCount(ids);
  }

  // ── Maintenance methods (for sleep addon / external tools) ──────────────

  buildWakeUp(ctxWindowSize: number): string {
    const { buildWakeUp } = require("./wake-up-builder.js") as typeof import("./wake-up-builder.js");
    return buildWakeUp(this.db, ctxWindowSize);
  }

  runWalCheckpoint(): boolean {
    if (!this.db) return false;
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); return true; } catch { return false; }
  }

  rebuildFtsIndexes(): { rebuilt: string[] } {
    if (!this.db) return { rebuilt: [] };
    const rebuilt: string[] = [];
    for (const table of ["extracted_memories_fts", "content_en_trigram", "content_original_trigram"]) {
      try { this.db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`); }
      catch {
        try { this.db.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild')`); rebuilt.push(table); }
        catch { /* table may not exist */ }
      }
    }
    return { rebuilt };
  }

  cleanupOldMessages(opts: { maxCount: number; maxAgeDays: number; garbageHours: number }): { deleted: number } {
    if (!this.db) return { deleted: 0 };
    let deleted = 0;
    try {
      // Age-based cleanup
      const ageCutoff = Date.now() - opts.maxAgeDays * 86400000;
      deleted += this.db.prepare("DELETE FROM messages WHERE timestamp < ?").run(ageCutoff).changes;
      // Count-based cleanup (keep newest maxCount)
      const excess = this.db.prepare("SELECT id FROM messages ORDER BY timestamp DESC LIMIT -1 OFFSET ?").all(opts.maxCount) as Array<{ id: number }>;
      if (excess.length > 0) {
        deleted += this.db.prepare(`DELETE FROM messages WHERE id IN (${excess.map(r => r.id).join(",")})`).run().changes;
      }
    } catch { /* */ }
    return { deleted };
  }

  async backfillEmbeddings(embedFn: (text: string) => Promise<Float32Array | null>): Promise<{ embedded: number }> {
    if (!this.db) return { embedded: 0 };
    let embedded = 0;
    const rows = this.db.prepare("SELECT id, content_en FROM extracted_memories WHERE embedding IS NULL").all() as Array<{ id: number; content_en: string }>;
    for (const row of rows) {
      const vec = await embedFn(row.content_en);
      if (vec) { this.db.prepare("UPDATE extracted_memories SET embedding = ? WHERE id = ?").run(Buffer.from(vec.buffer), row.id); embedded++; }
    }
    return { embedded };
  }

  deduplicateMessages(): { removed: number } {
    if (!this.db) return { removed: 0 };
    try {
      const dupes = this.db.prepare(`
        SELECT b.id FROM messages a JOIN messages b
        ON a.chat_id = b.chat_id AND a.role = b.role
        AND TRIM(a.content) = TRIM(b.content)
        AND b.id > a.id
        AND NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.chat_id = a.chat_id AND m.id > a.id AND m.id < b.id AND m.role = a.role
        )
      `).all() as Array<{ id: number }>;
      if (dupes.length > 0) {
        this.db.prepare(`DELETE FROM messages WHERE id IN (${dupes.map(d => d.id).join(",")})`).run();
        return { removed: dupes.length };
      }
    } catch { /* */ }
    return { removed: 0 };
  }

  /** Age memory tiers: NULL English after englishTtlDays, NULL original after originalTtlDays. */
  ageMemoryTiers(opts: { englishTtlDays: number; originalTtlDays: number; embeddingQuantizeDays?: number }): { englishNulled: number; originalNulled: number; embeddingsQuantized: number } {
    if (!this.db) return { englishNulled: 0, originalNulled: 0, embeddingsQuantized: 0 };
    const { isFlashbulb } = require("./brain-patterns.js") as typeof import("./brain-patterns.js");

    // content_en preserved forever — trigram search depends on it
    const englishNulled = 0;
    let originalNulled = 0;
    let embeddingsQuantized = 0;
    const originalCutoff = Date.now() - opts.originalTtlDays * 86400000;

    // Age Original (content_original) — only flashbulb protected
    const origRows = this.db.prepare(
      "SELECT id, emotion_score, importance_flags FROM extracted_memories WHERE content_original IS NOT NULL AND content_en IS NOT NULL AND created_at < ?",
    ).all(originalCutoff) as Array<{ id: number; emotion_score: number; importance_flags: string | null }>;
    for (const r of origRows) {
      if (isFlashbulb(r.emotion_score, r.importance_flags ?? "")) continue;
      this.db.prepare("UPDATE extracted_memories SET content_original = NULL WHERE id = ?").run(r.id);
      originalNulled++;
    }

    // Quantize float32 embeddings to int8 after quantizeDays
    if (opts.embeddingQuantizeDays != null) {
      const quantizeCutoff = Date.now() - opts.embeddingQuantizeDays * 86400000;
      try {
        const { quantizeToInt8 } = require("./embedding-quantize.js") as typeof import("./embedding-quantize.js");
        const rows = this.db.prepare(
          "SELECT memory_id, embedding FROM memory_embeddings WHERE quantized = 0 AND memory_id IN (SELECT id FROM extracted_memories WHERE created_at < ?)",
        ).all(quantizeCutoff) as Array<{ memory_id: number; embedding: Buffer }>;
        const updateStmt = this.db.prepare("UPDATE memory_embeddings SET embedding = ?, quantized = 1 WHERE memory_id = ?");
        for (const r of rows) {
          const float32 = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
          const int8 = quantizeToInt8(float32);
          updateStmt.run(Buffer.from(int8.buffer), r.memory_id);
          embeddingsQuantized++;
        }
      } catch { /* memory_embeddings table may not exist yet */ }
    }

    return { englishNulled, originalNulled, embeddingsQuantized };
  }

  /** Compute decayed confidence for all memories. Returns candidates for pruning (effective confidence < 1). */
  async computeDecayedConfidence(): Promise<Array<{ id: number; confidence: number; effectiveConfidence: number; recallCount: number; daysSinceRecall: number }>> {
    if (!this.db) return [];
    const { effectiveConfidence } = await import("./brain-patterns.js");
    const now = Date.now();
    const rows = this.db.prepare(
      `SELECT id, confidence, recall_count, last_recalled_at, created_at FROM extracted_memories WHERE valid_to IS NULL`,
    ).all() as Array<{ id: number; confidence: number; recall_count: number; last_recalled_at: number | null; created_at: number }>;

    const candidates: Array<{ id: number; confidence: number; effectiveConfidence: number; recallCount: number; daysSinceRecall: number }> = [];
    for (const r of rows) {
      const lastRecall = r.last_recalled_at ?? r.created_at;
      const daysSinceRecall = Math.round((now - lastRecall) / 86400000);
      const eff = effectiveConfidence(r.confidence, daysSinceRecall, r.recall_count);
      if (eff < 1) {
        candidates.push({ id: r.id, confidence: r.confidence, effectiveConfidence: eff, recallCount: r.recall_count, daysSinceRecall });
      }
    }
    return candidates.sort((a, b) => a.effectiveConfidence - b.effectiveConfidence);
  }

  fixMemoryDefaults(): { fixed: number } {
    if (!this.db) return { fixed: 0 };
    let fixed = 0;
    try {
      fixed += this.db.prepare("UPDATE extracted_memories SET trust = 2 WHERE memory_type = 'decision' AND trust < 2").run().changes;
      fixed += this.db.prepare("UPDATE extracted_memories SET classification = 1 WHERE memory_type = 'decision' AND classification = 0").run().changes;
      fixed += this.db.prepare("UPDATE extracted_memories SET trust = 2 WHERE trust = 0 AND credibility = 6 AND integrity = 2").run().changes;
      fixed += this.db.prepare("UPDATE extracted_memories SET credibility = 3 WHERE credibility = 6 AND created_at < ?").run(Date.now() - 7 * 86400000).changes;
    } catch { /* */ }
    return { fixed };
  }
}
