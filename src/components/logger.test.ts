import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock abtarsHome to use temp dir
const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
vi.mock("../paths.js", () => ({ abtarsHome: () => tmpDir }));

const { logInfo, logWarn, logDebug, logError, flushLogs, setLogLevel, setFileLogging, getLogFile } = await import("./logger.js");

describe("logger buffered writes", () => {
  beforeEach(() => {
    setFileLogging(true);
    setLogLevel("debug");
  });

  afterEach(() => {
    flushLogs();
  });

  it("does not write to disk before flush", () => {
    logInfo("test", "hello");
    const logFile = getLogFile();
    expect(existsSync(logFile)).toBe(false);
  });

  it("flushLogs writes buffered lines to disk", () => {
    logInfo("test", "line1");
    logWarn("test", "line2");
    flushLogs();
    const content = readFileSync(getLogFile(), "utf-8");
    expect(content).toContain("line1");
    expect(content).toContain("line2");
  });

  it("auto-flushes at 200 lines", () => {
    for (let i = 0; i < 200; i++) {
      logDebug("test", `bulk-${i}`);
    }
    const content = readFileSync(getLogFile(), "utf-8");
    expect(content).toContain("bulk-0");
    expect(content).toContain("bulk-199");
  });

  it("batches multiple lines into single write", () => {
    logInfo("test", "a");
    logInfo("test", "b");
    logInfo("test", "c");
    flushLogs();
    const content = readFileSync(getLogFile(), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it("persists a redacted full error stack", () => {
    const secret = "sk-" + "a".repeat(24);
    const err = new Error(`failure ${secret}`);
    err.stack = `CustomError: failure ${secret}\n    at stack-sentinel (reconciler.ts:1:1)`;

    logError("test", "reconcile failed", err);
    flushLogs();

    const content = readFileSync(getLogFile(), "utf-8");
    expect(content).toContain("stack-sentinel");
    expect(content).not.toContain(secret);
  });
});

describe("logger console/TTY redaction (#1354)", () => {
  const SENTINEL = "sk-or-console-sentinel-1354-9876543210";
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    flushLogs();
  });

  afterAll(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Patch console.log/warn/error directly (vitest spyOn misses module-scope calls). */
  function patchConsole(
    target: "log" | "warn" | "error",
  ): () => { calls: Array<Array<unknown>> } {
    const calls: Array<Array<unknown>> = [];
    const orig = (console as Record<string, unknown>)[target] as (...args: unknown[]) => void;
    (console as Record<string, unknown>)[target] = (...args: unknown[]) => { calls.push(args); };
    return () => {
      (console as Record<string, unknown>)[target] = orig;
      return { calls };
    };
  }

  it("redacts credentials before the console sink, not just the file", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const restoreLog = patchConsole("log");
    const restoreWarn = patchConsole("warn");
    try {
      logInfo("test", `OPENAI_API_KEY=${SENTINEL} in use`);
      logWarn("test", `provider failed with ${SENTINEL}`);
      flushLogs();
    } finally {
      const { calls: logCalls } = restoreLog();
      const { calls: warnCalls } = restoreWarn();
      const consoleOutput = [...logCalls, ...warnCalls].map(c => String(c[0])).join("\n");
      expect(consoleOutput).not.toContain(SENTINEL);
      expect(consoleOutput).toContain("***REDACTED***");
    }
  });

  it("redacts credential fragments from error rendering", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const restoreErr = patchConsole("error");
    try {
      logError("test", "boom", new Error(`header leaked ${SENTINEL}`));
      flushLogs();
    } finally {
      const { calls } = restoreErr();
      const rendered = calls.map(c => String(c[0])).join("\n") + calls.map(c => String(c[1])).join("\n");
      expect(rendered).not.toContain(SENTINEL);
    }
  });
});
