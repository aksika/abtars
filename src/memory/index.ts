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
export { SleepDataAccess } from "./sleep-data-access.js";
export type { SleepCandidateLists, EmotionalProfileEntry } from "./sleep-data-access.js";

// Recall engine (for search controller)
export { recallSearch } from "./recall-engine.js";

// Emotion utils
export { emojiToScore, emojiToTag, scoreFromTags, effectiveEmotion, tagFromScore } from "./emotion-utils.js";

// Session context
export { buildSessionStartContext } from "./session-context.js";
export { buildMemoryContext } from "./session-memory.js";

// Media
export { sanitizeForSummary } from "./media-sanitizer.js";

// Embedding
export { loadEmbedConfig, batchEmbed, embedText } from "./ollama-embed.js";

// ABM v2 — store-time enrichment
export { detectEmotions } from "./emotion-tagger.js";
export type { EmotionTag } from "./emotion-tagger.js";
export { detectFlags } from "./importance-flagger.js";
export type { ImportanceFlag } from "./importance-flagger.js";
export { compress } from "./memory-compressor.js";
export { generateSignature, hammingDistance, hammingSimilarity } from "./signature-generator.js";

// ABM v2 — sleep-time intelligence
export { buildArc } from "./emotion-arc.js";
export { checkContradiction } from "./contradiction-checker.js";
export { buildTimelines, buildCrossTopicTimelines, renderTimeline, renderCrossTopicTimeline, renderTimelines } from "./timeline-builder.js";
export type { Timeline, RenderedTimeline, TimelineMemory } from "./timeline-builder.js";

// ABM v2 — session start
export { buildWakeUp } from "./wake-up-builder.js";

// ABM v2 — brain patterns
export { isFlashbulb, isAgingProtected, effectiveConfidence, detectInterference } from "./brain-patterns.js";

// ABM v2 — config
export { loadMemoryEnv } from "./mem-config-env.js";
export type { SearchMode, MemoryEnvConfig } from "./mem-config-env.js";

// ABM v2 — compression level 2
export { renderWakeUp, compressDailySummary, compressSoul, pickLevel } from "./wake-up-renderer.js";
export type { CompressionLevel } from "./wake-up-renderer.js";

// ABM v2 — embedding quantization
export { quantizeToInt8, cosineSimInt8 } from "./embedding-quantize.js";
