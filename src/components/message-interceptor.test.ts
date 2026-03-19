import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interceptLargeMessage } from "./message-interceptor.js";

// Override OVERFLOW_DIR for tests by monkey-patching the module internals isn't clean,
// so we test the function directly — it writes to ~/.agentbridge/overflow/ in prod,
// but we can verify the logic with the default threshold.

describe("interceptLargeMessage", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      try { rmSync(p, { force: true }); } catch { /* */ }
    }
    cleanupPaths.length = 0;
  });

  it("returns text as-is when under threshold", () => {
    const result = interceptLargeMessage("short message", 100);
    expect(result.intercepted).toBe(false);
    expect(result.text).toBe("short message");
    expect(result.filePath).toBeUndefined();
  });

  it("returns text as-is when exactly at threshold", () => {
    const text = "x".repeat(100);
    const result = interceptLargeMessage(text, 100);
    expect(result.intercepted).toBe(false);
    expect(result.text).toBe(text);
  });

  it("intercepts and truncates when over threshold", () => {
    const text = "A".repeat(200);
    const result = interceptLargeMessage(text, 50);
    expect(result.intercepted).toBe(true);
    expect(result.filePath).toBeDefined();
    expect(result.text).toContain("Message truncated (200 chars)");
    expect(result.text).toContain(result.filePath!);
    // Preview should be at most 500 chars (PREVIEW_LENGTH)
    const previewEnd = result.text.indexOf("\n\n---");
    expect(previewEnd).toBeLessThanOrEqual(500);

    // Full content written to file
    const saved = readFileSync(result.filePath!, "utf-8");
    expect(saved).toBe(text);
    cleanupPaths.push(result.filePath!);
  });

  it("writes full content to overflow file", () => {
    const text = "Hello world! ".repeat(1000);
    const result = interceptLargeMessage(text, 100);
    expect(result.intercepted).toBe(true);
    expect(existsSync(result.filePath!)).toBe(true);
    expect(readFileSync(result.filePath!, "utf-8")).toBe(text);
    cleanupPaths.push(result.filePath!);
  });
});
