import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initUsageTracker, recordUsage, readUsage, resetUsage, flushUsage, getTotalTokens,
  type CostResolver,
} from "./usage-tracker.js";

describe("usage-tracker — #1311 C6 cache accounting", () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "abtars-usage-"));
    initUsageTracker(dir);
    resetUsage();
  });

  it("recordUsage stores the cache breakdown; readUsage aggregates it (total + byModel)", () => {
    recordUsage("glm-4.6", 1000, 200, "", { cacheRead: 800, cacheWrite: 50 });
    recordUsage("glm-4.6", 500, 100, ""); // L0-style: no cache
    flushUsage();
    const sum = readUsage(0, () => 0);
    expect(sum.inputTokens).toBe(1500);
    expect(sum.outputTokens).toBe(300);
    expect(sum.cacheRead).toBe(800);
    expect(sum.cacheWrite).toBe(50);
    expect(sum.byModel.get("glm-4.6")).toMatchObject({ in: 1500, out: 300, cacheRead: 800, cacheWrite: 50 });
  });

  it("R1: budget total counts in+out only — cache is a subset of `in`, never added on top", () => {
    const before = getTotalTokens();
    recordUsage("m", 1000, 200, "", { cacheRead: 900, cacheWrite: 0 });
    expect(getTotalTokens() - before).toBe(1200); // 1000+200, cache NOT double-counted
  });

  it("readUsage passes cache fields to the CostResolver and sums its result", () => {
    recordUsage("m", 1000, 200, "", { cacheRead: 800, cacheWrite: 0 });
    flushUsage();
    // uncached input @2/M, output @6/M, cacheRead @0.2/M (cache-inclusive `in`, per R1)
    const costOf: CostResolver = (e) => {
      const uncached = e.in - (e.cacheRead ?? 0) - (e.cacheWrite ?? 0);
      return (uncached * 2 + e.out * 6 + (e.cacheRead ?? 0) * 0.2) / 1_000_000;
    };
    const sum = readUsage(0, costOf);
    // uncached=200→400, out=200→1200, cacheRead=800→160 ⇒ 1760 / 1e6
    expect(sum.cost).toBeCloseTo(1760 / 1_000_000, 10);
  });

  it("legacy entries without cache fields aggregate as zero cache", () => {
    recordUsage("m", 100, 20, "");
    flushUsage();
    const sum = readUsage(0, () => 0);
    expect(sum.cacheRead).toBe(0);
    expect(sum.cacheWrite).toBe(0);
  });
});
