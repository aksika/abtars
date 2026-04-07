/**
 * IMemorySystem — the public contract for the memory system.
 * Consumers (bridge, OpenClaw, MCP server) program against this interface.
 * MemoryManager is the concrete implementation.
 */

import type { SearchOptions, SearchResult, MessageRecord } from "./mem-types.js";
import type { MemoryConfig } from "./memory-config.js";

export interface IMemorySystem {
  // Lifecycle
  initialize(opts?: { skipEmbeddingCheck?: boolean }): Promise<void>;
  close(): void;

  // Messages
  recordMessage(...args: [MessageRecord]): void;
  loadRecentMessages(chatId: number, sessionId: string, count: number): MessageRecord[];
  getLastMessageTimestamp(excludeSystem?: boolean): number;

  // Search
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  substringSearch(query: string, opts?: SearchOptions): SearchResult[];

  // Emotion
  updateEmotionByPlatformId(chatId: number | string, platformMessageId: number, score: number): boolean;

  // Read-only
  getStats(chatId?: number): { totalMessages: number; totalMemories: number; embeddingCount: number; nullEmbeddingCount: number } | null;
  readCoreKnowledge(): string;
  getLatestCompaction(chatId: number): { timestamp: number; summary: string } | null;
  getCronInfo(): { heartbeatRunning: boolean; intervalMs: number; tasks: string[]; taskStatuses: ReadonlyMap<string, string>; lastSleepAudit: string | null };
  getConfig(): MemoryConfig;

  // LLM integration
  setLlmCall(llmCall: (prompt: string, content: string) => Promise<string>): void;
  getLlmCall(): ((prompt: string, content: string) => Promise<string>) | null;

  // Heartbeat
  setHeartbeat(hb: IHeartbeat): void;
  stopHeartbeat(): void;
}

/** Minimal heartbeat interface — bridge implements this, memory only knows the contract. */
export interface IHeartbeat {
  registerTask(task: { name: string; heavy?: boolean; execute: () => Promise<boolean | void> }): void;
  stop(): void;
  readonly intervalMs: number;
  getTaskNames(): string[];
  getTaskStatuses(): ReadonlyMap<string, string>;
}
