import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock abtarsHome to use temp dir
const tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
vi.mock("../paths.js", () => ({ abtarsHome: () => tmpDir }));

const { logInfo, logWarn, logDebug, flushLogs, setLogLevel, setFileLogging, getLogFile } = await import("./logger.js");

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
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});
