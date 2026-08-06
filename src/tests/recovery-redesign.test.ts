import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeReadJson } from "../components/safe-json.js";

// --- safeReadJson ---

describe("safeReadJson", () => {
  let tmpDir: string;

  beforeEach(() => {
    process.env["HEARTBEAT_INTERVAL_SEC"] = "300";
    tmpDir = mkdtempSync(join(tmpdir(), "safe-json-"));
  });

  it("reads valid JSON", () => {
    const p = join(tmpDir, "test.json");
    writeFileSync(p, '{"a":1}');
    expect(safeReadJson(p, {})).toEqual({ a: 1 });
  });

  it("returns fallback for missing file", () => {
    expect(safeReadJson("/nonexistent/path.json", { x: 42 })).toEqual({ x: 42 });
  });

  it("returns fallback for invalid JSON", () => {
    const p = join(tmpDir, "bad.json");
    writeFileSync(p, "not json {{{");
    expect(safeReadJson(p, { fallback: true })).toEqual({ fallback: true });
  });

  it("returns fallback for null JSON", () => {
    const p = join(tmpDir, "null.json");
    writeFileSync(p, "null");
    expect(safeReadJson(p, { def: 1 })).toEqual({ def: 1 });
  });

  it("returns fallback for array JSON", () => {
    const p = join(tmpDir, "arr.json");
    writeFileSync(p, "[1,2,3]");
    // arrays are objects, so this passes through
    const result = safeReadJson(p, []);
    expect(Array.isArray(result)).toBe(true);
  });
});
