/**
 * MemoryBackend — abstract interface for memory storage.
 *
 * All methods are async to support both local (SQLite) and remote (IPC) backends.
 * CLI tools use createMemoryBackend() from backend-factory.ts.
 */

import type { InstantStoreParams, InstantStoreResult, EditMemoryParams, EditMemoryResult, ForgetResult } from "./mem-types.js";
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
  editMemory(params: EditMemoryParams): Promise<EditMemoryResult>;
  reclassifyMemory(id: number, level: number, userOverride: boolean): Promise<void>;
  adjustRelevance(id: number, delta: number): Promise<void>;
  mergeMemories(idA: number, idB: number): Promise<MergeResult>;
  cascadeDelete(messageIds: number[], chatId: number): Promise<ForgetResult>;

  // Recall
  recall(params: RecallParams): Promise<RecallResult>;
}
