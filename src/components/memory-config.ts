import { resolve } from "node:path";
import { homedir } from "node:os";
import { logWarn } from "./logger.js";

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
    scratchpad: number;
    recalled: number;
    working: number;
  };
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
    scratchpad: 300,
    recalled: 600,
    working: 2000,
  },
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
    scratchpad: parseNumberEnvSafe(
      "MEMORY_CONTEXT_BUDGET_SCRATCHPAD",
      MEMORY_CONFIG_DEFAULTS.contextBudget.scratchpad,
    ),
    recalled: parseNumberEnvSafe(
      "MEMORY_CONTEXT_BUDGET_RECALLED",
      MEMORY_CONFIG_DEFAULTS.contextBudget.recalled,
    ),
    working: parseNumberEnvSafe(
      "MEMORY_CONTEXT_BUDGET_WORKING",
      MEMORY_CONFIG_DEFAULTS.contextBudget.working,
    ),
  };

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
  };
}
