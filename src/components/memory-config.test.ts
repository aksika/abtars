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
      scratchpad: 300,
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
    process.env["MEMORY_CONTEXT_BUDGET_SCRATCHPAD"] = "400";
    process.env["MEMORY_CONTEXT_BUDGET_RECALLED"] = "900";
    process.env["MEMORY_CONTEXT_BUDGET_WORKING"] = "3000";
    const cfg = loadMemoryConfig();
    expect(cfg.contextBudget).toEqual({
      soul: 800,
      scratchpad: 400,
      recalled: 900,
      working: 3000,
    });
  });

  it("falls back to defaults for invalid context budget values", () => {
    process.env["MEMORY_CONTEXT_BUDGET_SOUL"] = "bad";
    process.env["MEMORY_CONTEXT_BUDGET_SCRATCHPAD"] = "bad";
    const cfg = loadMemoryConfig();
    expect(cfg.contextBudget.soul).toBe(500);
    expect(cfg.contextBudget.scratchpad).toBe(300);
    expect(logger.logWarn).toHaveBeenCalledTimes(2);
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
