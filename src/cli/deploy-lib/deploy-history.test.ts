/**
 * Tests for deploy.ts history.json dedup (#1277 Task 4).
 *
 * Verifies that history[0] !== history[1] after any deploy so the
 * circuit-breaker rollback target always differs from the just-deployed commit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Extract just the history logic so we can test it without the full deploy pipeline.
// This mirrors the exact code in deployActivation (~L173-181 of deploy.ts).
function applyHistoryUpdate(releasesDir: string, newRef: string): string[] {
  const historyFile = join(releasesDir, "history.json");
  let history: string[] = [];
  try { history = JSON.parse(readFileSync(historyFile, "utf-8")); } catch {}
  history = history.filter(h => h !== newRef);
  history.unshift(newRef);
  if (history.length > 4) history.pop(); // pruning (no rmSync in unit test)
  writeFileSync(historyFile, JSON.stringify(history) + "\n");
  return history;
}

describe("deploy.ts history.json dedup (#1277)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "history-dedup-test-"));
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("prepends new commit to empty history", () => {
    const h = applyHistoryUpdate(tmp, "abc1234");
    expect(h).toEqual(["abc1234"]);
  });

  it("does not duplicate when redeploying the same commit", () => {
    // Simulates the 14:55 recovery scenario: beea181 already at head
    writeFileSync(join(tmp, "history.json"), JSON.stringify(["beea181", "f439d0a", "eb35110"]));
    const h = applyHistoryUpdate(tmp, "beea181");
    expect(h[0]).toBe("beea181");
    expect(h[1]).toBe("f439d0a"); // NOT beea181 again
    expect(h.filter(x => x === "beea181")).toHaveLength(1);
  });

  it("prepends new commit and keeps distinct history", () => {
    writeFileSync(join(tmp, "history.json"), JSON.stringify(["beea181", "f439d0a", "eb35110"]));
    const h = applyHistoryUpdate(tmp, "newcommit");
    expect(h).toEqual(["newcommit", "beea181", "f439d0a", "eb35110"]);
  });

  it("caps at 4 entries and prunes oldest", () => {
    writeFileSync(join(tmp, "history.json"), JSON.stringify(["a", "b", "c", "d"]));
    const h = applyHistoryUpdate(tmp, "e");
    expect(h).toHaveLength(4);
    expect(h[0]).toBe("e");
    expect(h).not.toContain("d"); // oldest pruned
  });

  it("rollback target (history[1]) always differs from head after dedup", () => {
    // Populate with a duplicate (pre-fix state) and redeploy same commit
    writeFileSync(join(tmp, "history.json"), JSON.stringify(["x", "x", "y"]));
    const h = applyHistoryUpdate(tmp, "x");
    expect(h[0]).toBe("x");
    expect(h[1]).not.toBe("x"); // rollback target must differ
  });
});
