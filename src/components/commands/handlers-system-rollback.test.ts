import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";

/**
 * Test the rollback display logic directly (same algorithm as handlers-system.ts).
 * We test the algorithm, not the full command handler (too many deps to mock).
 */
function getRollbackSlots(releasesDir: string): string[] {
  const historyPath = join(releasesDir, "history.json");
  try {
    const history: string[] = JSON.parse(readFileSync(historyPath, "utf-8"));
    const prev = history.slice(1, 4);
    return [prev[0] ?? "(empty)", prev[1] ?? "(empty)", prev[2] ?? "(empty)"];
  } catch {
    return ["(empty)", "(empty)", "(empty)"];
  }
}

describe("rollback display — history.json parsing", () => {
  const testDir = join(tmpdir(), `rollback-test-${process.pid}`);

  beforeEach(() => { mkdirSync(testDir, { recursive: true }); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it("shows 3 previous versions from history", () => {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(["current", "prev1", "prev2", "prev3"]));
    expect(getRollbackSlots(testDir)).toEqual(["prev1", "prev2", "prev3"]);
  });

  it("fills (empty) when history has fewer entries", () => {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(["current", "prev1"]));
    expect(getRollbackSlots(testDir)).toEqual(["prev1", "(empty)", "(empty)"]);
  });

  it("all (empty) when only current in history", () => {
    writeFileSync(join(testDir, "history.json"), JSON.stringify(["current"]));
    expect(getRollbackSlots(testDir)).toEqual(["(empty)", "(empty)", "(empty)"]);
  });

  it("all (empty) when no history.json", () => {
    expect(getRollbackSlots(testDir)).toEqual(["(empty)", "(empty)", "(empty)"]);
  });

  it("all (empty) on corrupt JSON", () => {
    writeFileSync(join(testDir, "history.json"), "not json");
    expect(getRollbackSlots(testDir)).toEqual(["(empty)", "(empty)", "(empty)"]);
  });
});
