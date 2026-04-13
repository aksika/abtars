/**
 * IMemoryCore — the public API for external consumers (MCP, OpenClaw, steering, CLI).
 * IMemorySystem — extends IMemoryCore with bridge-internal methods.
 * MemoryManager is the concrete implementation of both.
 */

import type { SearchOptions, SearchResult, MessageRecord } from "./mem-types.js";
import type { MemoryConfig } from "./memory-config.js";

/** Public API — what external consumers program against. */
export interface IMemoryCore {
  initialize(opts?: { skipEmbeddingCheck?: boolean }): Promise<void>;
  close(): void;

  // Search & recall
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  substringSearch(query: string, opts?: SearchOptions): SearchResult[];
  recallSearch(params: import("./recall-engine.js").RecallParams): Promise<import("./recall-engine.js").RecallResult>;
  bumpRecallCount(ids: number[]): void;

  // Context injection
  buildWakeUp(ctxWindowSize: number): string;
  readCoreKnowledge(): string;

  // Stats
  getStats(chatId?: number): {
    totalMessages: number; extractedMemories: number; extractedByType: Record<string, number>;
    consolidationFiles: { daily: number; weekly: number; quarterly: number };
    ingestedDocuments: number; preservedKeywords: number; heartbeatRunning: boolean; dbSizeBytes: number;
  } | null;
  getConfig(): MemoryConfig;
}

/** Bridge-internal API — extends IMemoryCore with transport/platform-specific methods. */
export interface IMemorySystem extends IMemoryCore {
  // Lifecycle
  initialize(opts?: { skipEmbeddingCheck?: boolean }): Promise<void>;
  close(): void;

  // Messages
  recordMessage(...args: [MessageRecord]): void;
  loadRecentMessages(chatId: number, sessionId: string, count: number): MessageRecord[];
  getLastMessageTimestamp(excludeSystem?: boolean): number;

  // Emotion
  updateEmotionByPlatformId(chatId: number | string, platformMessageId: number, score: number): boolean;

  // Bridge-specific read-only
  getLatestCompaction(chatId: number): { timestamp: number; summary: string } | null;
  getCronInfo(): { heartbeatRunning: boolean; intervalMs: number; tasks: string[]; taskStatuses: ReadonlyMap<string, string>; lastSleepAudit: string | null };

  // LLM integration
  setLlmCall(llmCall: (prompt: string, content: string) => Promise<string>): void;
  getLlmCall(): ((prompt: string, content: string) => Promise<string>) | null;

  // Heartbeat
  setHeartbeat(hb: IHeartbeat): void;
  stopHeartbeat(): void;

  // Sleep data access
  getSleepData(): import("./sleep-data-access.js").SleepDataAccess;

  // Dashboard
  getDistinctChatIds(): number[];
  getAllExtractedMemories(): unknown[];
  getAllEntities(): unknown[];
  getAllEntityLinks(): unknown[];

  // Maintenance
  runWalCheckpoint(): boolean;
  rebuildFtsIndexes(): { rebuilt: string[] };
  cleanupOldMessages(opts: { maxCount: number; maxAgeDays: number; garbageHours: number }): { deleted: number };
  backfillEmbeddings(embedFn: (text: string) => Promise<Float32Array | null>): Promise<{ embedded: number }>;
  deduplicateMessages(): { removed: number };
  fixMemoryDefaults(): { fixed: number };
}

/** Minimal heartbeat interface — bridge implements this, memory only knows the contract. */
export interface IHeartbeat {
  registerTask(task: { name: string; heavy?: boolean; execute: () => Promise<boolean | void> }): void;
  stop(): void;
  readonly intervalMs: number;
  getTaskNames(): string[];
  getTaskStatuses(): ReadonlyMap<string, string>;
}
