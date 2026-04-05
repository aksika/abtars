/**
 * MemoryBackend — abstract interface for memory storage.
 *
 * CLI tools (store, edit, recall) use this instead of MemoryManager directly.
 * The default implementation wraps MemoryManager + SQLite.
 * Future backends (Honcho, Redis, etc.) implement the same interface.
 *
 * Config selects the backend: MEMORY_BACKEND=sqlite (default).
 */

import type { InstantStoreParams, InstantStoreResult, EditMemoryParams, EditMemoryResult, ForgetResult } from "../types/index.js";
import type { RecallParams, RecallResult } from "./recall-engine.js";

/** Merge result from combining two memories. */
export type MergeResult = { merged: true; keptId: number; deletedId: number } | { merged: false; error: string };

/** Abstract memory backend — all CLI tools go through this. */
export interface MemoryBackend {
  initialize(): Promise<void>;
  close(): void;

  // Store
  instantStore(params: InstantStoreParams): Promise<InstantStoreResult>;

  // Edit
  editMemory(params: EditMemoryParams): EditMemoryResult;
  reclassifyMemory(id: number, level: number, userOverride: boolean): void;
  adjustRelevance(id: number, delta: number): void;
  mergeMemories(idA: number, idB: number): MergeResult;
  cascadeDelete(messageIds: number[], chatId: number): ForgetResult;

  // Recall
  recall(params: RecallParams): Promise<RecallResult>;
}
