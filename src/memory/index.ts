/**
 * @agentbridge/memory — standalone memory system.
 *
 * Public API: IMemorySystem interface + MemoryManager implementation.
 * All consumers should import from this index.
 */

// Interface
export type { IMemorySystem, IHeartbeat } from "./imemory-system.js";

// Implementation
export { MemoryManager } from "./memory-manager.js";

// Config
export { loadMemoryConfig } from "./memory-config.js";
export type { MemoryConfig } from "./memory-config.js";

// Backend (for CLIs that need direct access)
export { createMemoryBackend } from "./backend-factory.js";
export type { MemoryBackend } from "./memory-backend.js";

// Types
export type {
  MessageRecord,
  SearchResult,
  SearchOptions,
  ForgetResult,
  InstantStoreParams,
  InstantStoreResult,
  EditMemoryParams,
  EditMemoryResult,
  ExtractedMemory,
  MemorySearchResult,
  HeartbeatTask,
} from "./mem-types.js";

// Utilities (for standalone use)
export { setLogger } from "./mem-logger.js";
export { agentBridgeHome } from "./mem-paths.js";

// Sleep state (for sleep CLI)
export { SleepStateGatherer } from "./sleep-state-gatherer.js";
export type { StateSnapshot } from "./sleep-state-gatherer.js";

// Recall engine (for search controller)
export { recallSearch } from "./recall-engine.js";

// Emotion utils
export { emojiToScore } from "./emotion-utils.js";

// Session context
export { buildSessionStartContext } from "./session-context.js";
