import { resolve } from "node:path";
import { homedir } from "node:os";
import { logWarn } from "./logger.js";

/** Configuration for the recall fallback pipeline. */
export type RecallFallbackConfig = {
  enabled: boolean;
  timeoutMs: number;
  contextMessages: number;
  minTokenLength: number;
  cuePhrases?: string;
};

/** Configuration for the local memory layer. */
export type MemoryConfig = {
  memoryEnabled: boolean;
  memoryDir: string;
  maxMessagesPerChat: number;
  diskBudgetBytes: number;
  vectorEnabled: boolean;
  stalenessThresholdMs: number;
  restoreMessageCount: number;
  compactOnReset: boolean;
  autoCompactThreshold: number;
  contextBudget: {
    soul: number;
    recalled: number;
    working: number;
  };
  /** Number of recent messages kept in full detail in the working memory tier. */
  rollingBufferSize: number;
  /** Maximum token size per ingestion chunk. */
  ingestChunkMaxTokens: number;
  /** Embedding model name for hot-swap detection. */
  embeddingModel: string;
  /** Relevance threshold for topic-based forgetting. */
  forgetThreshold: number;
  /** Recall fallback pipeline configuration. */
  recallFallback: RecallFallbackConfig;
  /** Heartbeat system configuration for background processing. */
  heartbeat: {
    enabled: boolean;
    intervalMs: number;
  };
  /** Search enhancement configuration for temporal decay, MMR, and timeouts. */
  searchEnhancements: {
    searchTimeoutMs: number;
    decayHalflifeDays: number;
    mmrLambda: number;
    compactThresholdPct: number;
  };
  /** Inactivity gap in hours after midnight before daily compaction triggers. */
  dayBoundaryHours: number;
};

const TAG = "memory-config";

/** Default values for all memory configuration fields. */
export const MEMORY_CONFIG_DEFAULTS: MemoryConfig = {
  memoryEnabled: true,
  memoryDir: resolve(homedir(), ".agentbridge", "memory"),
  maxMessagesPerChat: 1000,
  diskBudgetBytes: 500 * 1024 * 1024,
  vectorEnabled: false,
  stalenessThresholdMs: 24 * 3600_000,
  restoreMessageCount: 50,
  compactOnReset: false,
  autoCompactThreshold: 3000,
  contextBudget: {
    soul: 500,
    recalled: 600,
    working: 2000,
  },
  rollingBufferSize: 20,
  ingestChunkMaxTokens: 512,
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  forgetThreshold: 0.8,
  recallFallback: {
    enabled: true,
    timeoutMs: 500,
    contextMessages: 5,
    minTokenLength: 3,
  },
  heartbeat: {
    enabled: true,
    intervalMs: 300000,
  },
  searchEnhancements: {
    searchTimeoutMs: 1000,
    decayHalflifeDays: 30,
    mmrLambda: 0.7,
    compactThresholdPct: 85,
  },
  dayBoundaryHours: 4,
};

/**
 * Parse an env var as a boolean ("true"/"1" → true, anything else → false).
 * Mirrors the pattern in config.ts.
 */
function parseBooleanEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

/**
 * Parse an env var as a finite number. Logs a warning and returns the fallback
 * for invalid values instead of throwing (graceful degradation).
 */
function parseNumberEnvSafe(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    logWarn(TAG, `${key} must be a valid number, got "${raw}" — using default ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * Load memory configuration from `process.env` with sensible defaults.
 * Invalid values produce a warning and fall back to defaults (never throws).
 */
export function loadMemoryConfig(): MemoryConfig {
  const memoryEnabled = parseBooleanEnv("MEMORY_ENABLED", MEMORY_CONFIG_DEFAULTS.memoryEnabled);
  const memoryDir = process.env["MEMORY_DIR"] || MEMORY_CONFIG_DEFAULTS.memoryDir;

  const maxMessagesPerChat = parseNumberEnvSafe(
    "MEMORY_MAX_MESSAGES_PER_CHAT",
    MEMORY_CONFIG_DEFAULTS.maxMessagesPerChat,
  );
  const diskBudgetMb = parseNumberEnvSafe("MEMORY_DISK_BUDGET_MB", 500);
  const diskBudgetBytes = diskBudgetMb * 1024 * 1024;

  const vectorEnabled = parseBooleanEnv("MEMORY_VECTOR_ENABLED", MEMORY_CONFIG_DEFAULTS.vectorEnabled);

  const stalenessHours = parseNumberEnvSafe("MEMORY_STALENESS_HOURS", 24);
  const stalenessThresholdMs = stalenessHours * 3_600_000;

  const restoreMessageCount = parseNumberEnvSafe(
    "MEMORY_RESTORE_MESSAGES",
    MEMORY_CONFIG_DEFAULTS.restoreMessageCount,
  );

  const compactOnReset = parseBooleanEnv("MEMORY_COMPACT_ON_RESET", MEMORY_CONFIG_DEFAULTS.compactOnReset);

  const autoCompactThreshold = parseNumberEnvSafe(
    "MEMORY_AUTO_COMPACT_THRESHOLD",
    MEMORY_CONFIG_DEFAULTS.autoCompactThreshold,
  );

  const contextBudget = {
    soul: parseNumberEnvSafe("MEMORY_CONTEXT_BUDGET_SOUL", MEMORY_CONFIG_DEFAULTS.contextBudget.soul),
    recalled: parseNumberEnvSafe(
      "MEMORY_CONTEXT_BUDGET_RECALLED",
      MEMORY_CONFIG_DEFAULTS.contextBudget.recalled,
    ),
    working: parseNumberEnvSafe(
      "MEMORY_CONTEXT_BUDGET_WORKING",
      MEMORY_CONFIG_DEFAULTS.contextBudget.working,
    ),
  };

  const rollingBufferSize = parseNumberEnvSafe(
    "MEMORY_ROLLING_BUFFER_SIZE",
    MEMORY_CONFIG_DEFAULTS.rollingBufferSize,
  );

  const ingestChunkMaxTokens = parseNumberEnvSafe(
    "MEMORY_INGEST_CHUNK_MAX_TOKENS",
    MEMORY_CONFIG_DEFAULTS.ingestChunkMaxTokens,
  );

  const embeddingModel = process.env["MEMORY_EMBEDDING_MODEL"] || MEMORY_CONFIG_DEFAULTS.embeddingModel;

  const forgetThreshold = parseNumberEnvSafe("MEMORY_FORGET_THRESHOLD", MEMORY_CONFIG_DEFAULTS.forgetThreshold);

  // Recall fallback pipeline config
  const recallFallbackEnabled = parseBooleanEnv(
    "MEMORY_RECALL_FALLBACK_ENABLED",
    MEMORY_CONFIG_DEFAULTS.recallFallback.enabled,
  );
  const recallFallbackTimeoutMs = parseNumberEnvSafe(
    "MEMORY_RECALL_FALLBACK_TIMEOUT_MS",
    MEMORY_CONFIG_DEFAULTS.recallFallback.timeoutMs,
  );
  const recallContextMessages = parseNumberEnvSafe(
    "MEMORY_RECALL_CONTEXT_MESSAGES",
    MEMORY_CONFIG_DEFAULTS.recallFallback.contextMessages,
  );
  const recallMinTokenLength = parseNumberEnvSafe(
    "MEMORY_RECALL_MIN_TOKEN_LENGTH",
    MEMORY_CONFIG_DEFAULTS.recallFallback.minTokenLength,
  );

  let recallCuePhrases: string | undefined;
  const rawCuePhrases = process.env["MEMORY_RECALL_CUE_PHRASES"];
  if (rawCuePhrases !== undefined && rawCuePhrases !== "") {
    try {
      JSON.parse(rawCuePhrases);
      recallCuePhrases = rawCuePhrases;
    } catch {
      logWarn(TAG, `MEMORY_RECALL_CUE_PHRASES is not valid JSON: "${rawCuePhrases}" — using built-in defaults`);
    }
  }

  return {
    memoryEnabled,
    memoryDir,
    maxMessagesPerChat,
    diskBudgetBytes,
    vectorEnabled,
    stalenessThresholdMs,
    restoreMessageCount,
    compactOnReset,
    autoCompactThreshold,
    contextBudget,
    rollingBufferSize,
    ingestChunkMaxTokens,
    embeddingModel,
    forgetThreshold,
    recallFallback: {
      enabled: recallFallbackEnabled,
      timeoutMs: recallFallbackTimeoutMs,
      contextMessages: recallContextMessages,
      minTokenLength: recallMinTokenLength,
      ...(recallCuePhrases !== undefined && { cuePhrases: recallCuePhrases }),
    },
    heartbeat: {
      enabled: parseBooleanEnv("MEMORY_HEARTBEAT_ENABLED", MEMORY_CONFIG_DEFAULTS.heartbeat.enabled),
      intervalMs: parseNumberEnvSafe("MEMORY_HEARTBEAT_INTERVAL_MS", MEMORY_CONFIG_DEFAULTS.heartbeat.intervalMs),
    },
    searchEnhancements: {
      searchTimeoutMs: parseNumberEnvSafe("MEMORY_SEARCH_TIMEOUT_MS", MEMORY_CONFIG_DEFAULTS.searchEnhancements.searchTimeoutMs),
      decayHalflifeDays: parseNumberEnvSafe("MEMORY_DECAY_HALFLIFE_DAYS", MEMORY_CONFIG_DEFAULTS.searchEnhancements.decayHalflifeDays),
      mmrLambda: parseNumberEnvSafe("MEMORY_MMR_LAMBDA", MEMORY_CONFIG_DEFAULTS.searchEnhancements.mmrLambda),
      compactThresholdPct: parseNumberEnvSafe("MEMORY_COMPACT_THRESHOLD_PCT", MEMORY_CONFIG_DEFAULTS.searchEnhancements.compactThresholdPct),
    },
    dayBoundaryHours: parseNumberEnvSafe("MEMORY_DAY_BOUNDARY_HOURS", MEMORY_CONFIG_DEFAULTS.dayBoundaryHours),
  };
}
