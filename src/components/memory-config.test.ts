import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { loadMemoryConfig, MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
import * as logger from "./logger.js";

vi.mock("./logger.js", () => ({
  logWarn: vi.fn(),
}));

/** Wipe all MEMORY_* env vars so each test starts clean. */
function clearMemoryEnv() {
  const keys = Object.keys(process.env).filter((k) => k.startsWith("MEMORY_"));
  for (const k of keys) delete process.env[k];
}

describe("loadMemoryConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearMemoryEnv();
  });

  afterEach(() => {
    clearMemoryEnv();
  });

  // --- Defaults ---

  it("returns all defaults when no env vars are set", () => {
    const cfg = loadMemoryConfig();
    expect(cfg.memoryEnabled).toBe(true);
    expect(cfg.memoryDir).toBe(resolve(homedir(), ".agentbridge", "memory"));
    expect(cfg.maxMessagesPerChat).toBe(1000);
    expect(cfg.diskBudgetBytes).toBe(500 * 1024 * 1024);
    expect(cfg.vectorEnabled).toBe(false);
    expect(cfg.stalenessThresholdMs).toBe(24 * 3_600_000);
    expect(cfg.restoreMessageCount).toBe(50);
    expect(cfg.compactOnReset).toBe(false);
    expect(cfg.autoCompactThreshold).toBe(3000);
    expect(cfg.contextBudget).toEqual({
      soul: 500,
      recalled: 600,
      working: 2000,
    });
    expect(cfg.rollingBufferSize).toBe(20);
  });

  // --- MEMORY_ENABLED ---

  it("parses MEMORY_ENABLED=false", () => {
    process.env["MEMORY_ENABLED"] = "false";
    expect(loadMemoryConfig().memoryEnabled).toBe(false);
  });

  it("parses MEMORY_ENABLED=1 as true", () => {
    process.env["MEMORY_ENABLED"] = "1";
    expect(loadMemoryConfig().memoryEnabled).toBe(true);
  });

  // --- MEMORY_DIR ---

  it("uses MEMORY_DIR from env when set", () => {
    process.env["MEMORY_DIR"] = "/tmp/custom-memory";
    expect(loadMemoryConfig().memoryDir).toBe("/tmp/custom-memory");
  });

  // --- MEMORY_MAX_MESSAGES_PER_CHAT ---

  it("parses MEMORY_MAX_MESSAGES_PER_CHAT as a number", () => {
    process.env["MEMORY_MAX_MESSAGES_PER_CHAT"] = "500";
    expect(loadMemoryConfig().maxMessagesPerChat).toBe(500);
  });

  it("falls back to default for invalid MEMORY_MAX_MESSAGES_PER_CHAT", () => {
    process.env["MEMORY_MAX_MESSAGES_PER_CHAT"] = "not-a-number";
    const cfg = loadMemoryConfig();
    expect(cfg.maxMessagesPerChat).toBe(1000);
    expect(logger.logWarn).toHaveBeenCalledWith(
      "memory-config",
      expect.stringContaining("MEMORY_MAX_MESSAGES_PER_CHAT"),
    );
  });

  // --- MEMORY_DISK_BUDGET_MB ---

  it("converts MEMORY_DISK_BUDGET_MB to bytes", () => {
    process.env["MEMORY_DISK_BUDGET_MB"] = "100";
    expect(loadMemoryConfig().diskBudgetBytes).toBe(100 * 1024 * 1024);
  });

  it("falls back to default for invalid MEMORY_DISK_BUDGET_MB", () => {
    process.env["MEMORY_DISK_BUDGET_MB"] = "abc";
    const cfg = loadMemoryConfig();
    expect(cfg.diskBudgetBytes).toBe(500 * 1024 * 1024);
    expect(logger.logWarn).toHaveBeenCalled();
  });

  // --- MEMORY_VECTOR_ENABLED ---

  it("parses MEMORY_VECTOR_ENABLED=true", () => {
    process.env["MEMORY_VECTOR_ENABLED"] = "true";
    expect(loadMemoryConfig().vectorEnabled).toBe(true);
  });

  // --- MEMORY_STALENESS_HOURS ---

  it("converts MEMORY_STALENESS_HOURS to milliseconds", () => {
    process.env["MEMORY_STALENESS_HOURS"] = "48";
    expect(loadMemoryConfig().stalenessThresholdMs).toBe(48 * 3_600_000);
  });

  it("falls back to default for invalid MEMORY_STALENESS_HOURS", () => {
    process.env["MEMORY_STALENESS_HOURS"] = "NaN";
    const cfg = loadMemoryConfig();
    expect(cfg.stalenessThresholdMs).toBe(24 * 3_600_000);
    expect(logger.logWarn).toHaveBeenCalled();
  });

  // --- MEMORY_RESTORE_MESSAGES ---

  it("parses MEMORY_RESTORE_MESSAGES", () => {
    process.env["MEMORY_RESTORE_MESSAGES"] = "100";
    expect(loadMemoryConfig().restoreMessageCount).toBe(100);
  });

  // --- MEMORY_COMPACT_ON_RESET ---

  it("parses MEMORY_COMPACT_ON_RESET=true", () => {
    process.env["MEMORY_COMPACT_ON_RESET"] = "true";
    expect(loadMemoryConfig().compactOnReset).toBe(true);
  });

  // --- MEMORY_AUTO_COMPACT_THRESHOLD ---

  it("parses MEMORY_AUTO_COMPACT_THRESHOLD", () => {
    process.env["MEMORY_AUTO_COMPACT_THRESHOLD"] = "5000";
    expect(loadMemoryConfig().autoCompactThreshold).toBe(5000);
  });

  it("falls back to default for invalid MEMORY_AUTO_COMPACT_THRESHOLD", () => {
    process.env["MEMORY_AUTO_COMPACT_THRESHOLD"] = "Infinity";
    const cfg = loadMemoryConfig();
    expect(cfg.autoCompactThreshold).toBe(3000);
    expect(logger.logWarn).toHaveBeenCalled();
  });

  // --- Context budget ---

  it("parses all context budget env vars", () => {
    process.env["MEMORY_CONTEXT_BUDGET_SOUL"] = "800";
    process.env["MEMORY_CONTEXT_BUDGET_RECALLED"] = "900";
    process.env["MEMORY_CONTEXT_BUDGET_WORKING"] = "3000";
    const cfg = loadMemoryConfig();
    expect(cfg.contextBudget).toEqual({
      soul: 800,
      recalled: 900,
      working: 3000,
    });
  });

  it("falls back to defaults for invalid context budget values", () => {
    process.env["MEMORY_CONTEXT_BUDGET_SOUL"] = "bad";
    const cfg = loadMemoryConfig();
    expect(cfg.contextBudget.soul).toBe(500);
    expect(logger.logWarn).toHaveBeenCalledTimes(1);
  });

  // --- MEMORY_ROLLING_BUFFER_SIZE ---

  it("parses MEMORY_ROLLING_BUFFER_SIZE", () => {
    process.env["MEMORY_ROLLING_BUFFER_SIZE"] = "50";
    expect(loadMemoryConfig().rollingBufferSize).toBe(50);
  });

  it("falls back to default for invalid MEMORY_ROLLING_BUFFER_SIZE", () => {
    process.env["MEMORY_ROLLING_BUFFER_SIZE"] = "nope";
    const cfg = loadMemoryConfig();
    expect(cfg.rollingBufferSize).toBe(20);
    expect(logger.logWarn).toHaveBeenCalledWith(
      "memory-config",
      expect.stringContaining("MEMORY_ROLLING_BUFFER_SIZE"),
    );
  });
});

// Feature: memory-recall-fallback, Property 13: Configuration Resilience
import fc from "fast-check";

describe("loadMemoryConfig — Property 13: Configuration Resilience", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearMemoryEnv();
  });

  afterEach(() => {
    clearMemoryEnv();
  });

  it("recallFallback fields are never undefined, NaN, or null for any env var combination", () => {
    /**
     * Validates: Requirements 5.1, 5.5
     *
     * For any set of environment variable values (valid numbers, invalid strings,
     * empty, or missing), loadMemoryConfig().recallFallback should have all fields
     * populated — never undefined, NaN, or null.
     */
    const envVarArb = fc.option(fc.oneof(fc.string(), fc.constant("")), { nil: undefined });

    fc.assert(
      fc.property(
        envVarArb,
        envVarArb,
        envVarArb,
        envVarArb,
        envVarArb,
        (fallbackEnabled, timeoutMs, contextMessages, minTokenLength, cuePhrases) => {
          clearMemoryEnv();

          if (fallbackEnabled !== undefined) process.env["MEMORY_RECALL_FALLBACK_ENABLED"] = fallbackEnabled;
          if (timeoutMs !== undefined) process.env["MEMORY_RECALL_FALLBACK_TIMEOUT_MS"] = timeoutMs;
          if (contextMessages !== undefined) process.env["MEMORY_RECALL_CONTEXT_MESSAGES"] = contextMessages;
          if (minTokenLength !== undefined) process.env["MEMORY_RECALL_MIN_TOKEN_LENGTH"] = minTokenLength;
          if (cuePhrases !== undefined) process.env["MEMORY_RECALL_CUE_PHRASES"] = cuePhrases;

          const cfg = loadMemoryConfig();
          const rf = cfg.recallFallback;

          // enabled must be a boolean (not undefined/null)
          expect(typeof rf.enabled).toBe("boolean");
          expect(rf.enabled).not.toBeNull();
          expect(rf.enabled).not.toBeUndefined();

          // timeoutMs must be a finite number (not NaN/undefined/null)
          expect(typeof rf.timeoutMs).toBe("number");
          expect(Number.isFinite(rf.timeoutMs)).toBe(true);
          expect(rf.timeoutMs).not.toBeNull();
          expect(rf.timeoutMs).not.toBeUndefined();

          // contextMessages must be a finite number (not NaN/undefined/null)
          expect(typeof rf.contextMessages).toBe("number");
          expect(Number.isFinite(rf.contextMessages)).toBe(true);
          expect(rf.contextMessages).not.toBeNull();
          expect(rf.contextMessages).not.toBeUndefined();

          // minTokenLength must be a finite number (not NaN/undefined/null)
          expect(typeof rf.minTokenLength).toBe("number");
          expect(Number.isFinite(rf.minTokenLength)).toBe(true);
          expect(rf.minTokenLength).not.toBeNull();
          expect(rf.minTokenLength).not.toBeUndefined();

          // cuePhrases, if present, must be a string (not undefined/null/NaN)
          if ("cuePhrases" in rf && rf.cuePhrases !== undefined) {
            expect(typeof rf.cuePhrases).toBe("string");
            expect(rf.cuePhrases).not.toBeNull();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
