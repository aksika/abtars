import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clampMaxOutputTokens, estimateTokensFromChars, calculateReserve, proportionalSafetyMargin } from "./token-budget.js";
import type { ContextReserveInput } from "./token-budget.js";
import * as logger from "../logger.js";

describe("estimateTokensFromChars", () => {
  it("rounds up charCount/4 to a positive integer", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromChars(100)).toBe(25);
  });
});

describe("clampMaxOutputTokens", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("passes maxOutput through unchanged when under budget", () => {
    // 1024 + 1024 + 4096 = 6144 < 16384 → no clamp
    expect(clampMaxOutputTokens(1024, 16384, 1024)).toBe(1024);
  });

  it("passes through exactly-at-budget requests (no clamp when maxOutput == available)", () => {
    // contextWindow 16384, input 1024, margin 4096 → available 11264
    // maxOutput 11264 → exactly at the limit, no clamp needed
    expect(clampMaxOutputTokens(11264, 16384, 1024)).toBe(11264);
  });

  it("clamps maxOutput to contextWindow - input - safetyMargin when over budget", () => {
    // The #1326 trigger case: maxOutput 262144 > available 11264
    expect(clampMaxOutputTokens(262144, 16384, 1024)).toBe(11264);
  });

  it("clamps to a small positive number when maxOutput is grossly over budget", () => {
    // maxOutput 50000, context 10000, input 2000, default margin 4096 → available 3904
    expect(clampMaxOutputTokens(50000, 10000, 2000)).toBe(3904);
  });

  it("passes through unclamped when contextWindow is unknown (0)", () => {
    expect(clampMaxOutputTokens(262144, 0, 1024)).toBe(262144);
    // Negative contextWindow treated the same as 0/unknown — defensive
    expect(clampMaxOutputTokens(262144, -1, 1024)).toBe(262144);
  });

  it("clamps to 1 (and logs a warning) when input alone exceeds contextWindow - safetyMargin", () => {
    // contextWindow 10000, input 8000, margin 4096 → available -2096 → < 1
    expect(clampMaxOutputTokens(1024, 10000, 8000)).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toBe("token-budget");
    expect(warnSpy.mock.calls[0]![1]).toMatch(/already exceeds contextWindow/);
  });

  it("does NOT log a warning when clamp result is non-trivial (normal case)", () => {
    // Normal clamp case: maxOutput 262144 → 11264. The clamp is doing its job,
    // the input is well within budget — no need to log.
    clampMaxOutputTokens(262144, 16384, 1024);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("respects a custom safetyMargin", () => {
    // contextWindow 10000, input 0, margin 1000 → available 9000
    expect(clampMaxOutputTokens(50000, 10000, 0, 1000)).toBe(9000);
  });
});

// ── #1335 reserve calculator ─────────────────────────────────────────────────

describe("calculateReserve", () => {
  function makeInput(overrides: Partial<ContextReserveInput> = {}): ContextReserveInput {
    return {
      contextWindow: 128_000,
      configuredMaxOutput: 4096,
      clampedMaxOutput: 4096,
      safetyMargin: 4096,
      stableSystemTokens: 500,
      toolSchemaTokens: 2000,
      volatileContextTokens: 300,
      currentTurnTokens: 100,
      inFlightTokens: 0,
      // Small by default so compaction is NOT due; tests that want compaction
      // pass a large stableContextTokens. (#1335 finding #2)
      stableContextTokens: 1000,
      recentAtomicGrowthTokens: [800, 1200, 900, 1500, 1100],
      ...overrides,
    };
  }

  it("computes usableInput from context window minus output and margin", () => {
    const r = calculateReserve(makeInput());
    expect(r.usableInput).toBe(128_000 - 4096 - 4096); // 119808
  });

  it("computes historyBudget after subtracting overhead", () => {
    const r = calculateReserve(makeInput());
    const overhead = 500 + 2000 + 300 + 100 + 0;
    expect(r.historyBudget).toBe(128_000 - 4096 - 4096 - overhead);
  });

  it("returns zero historyBudget when overhead exceeds usable input", () => {
    const r = calculateReserve(makeInput({
      contextWindow: 10_000,
      stableSystemTokens: 5000,
      toolSchemaTokens: 5000,
      volatileContextTokens: 1000,
      currentTurnTokens: 500,
    }));
    expect(r.historyBudget).toBe(0);
    expect(r.usableInput).toBe(10_000 - 4096 - 4096); // 1808
  });

  it("sets reservedOutput to clamped value", () => {
    const r = calculateReserve(makeInput({ clampedMaxOutput: 2048 }));
    expect(r.reservedOutput).toBe(2048);
  });

  it("growthReserve uses P90 of recent growth, bounded", () => {
    const r = calculateReserve(makeInput({ recentAtomicGrowthTokens: [512, 512, 512, 512, 512, 512, 512, 512, 512, 10000] }));
    // P90 of sorted [512,...,512,10000] is 10000, capped at 10% of contextWindow (12800)
    expect(r.growthReserve).toBe(10000);
  });

  it("growthReserve has minimum floor of 512", () => {
    const r = calculateReserve(makeInput({ recentAtomicGrowthTokens: [10, 20, 30] }));
    expect(r.growthReserve).toBeGreaterThanOrEqual(512);
  });

  it("compactionDue is false when there's enough headroom for the real stable prefix", () => {
    // historyBudget is large; stableContextTokens (1000) + growthReserve fits.
    const r = calculateReserve(makeInput({
      contextWindow: 1_000_000,
      stableContextTokens: 1000,
      recentAtomicGrowthTokens: [800],
    }));
    expect(r.compactionDue).toBe(false);
  });

  it("compactionDue is false when stable prefix plus growth reserve fits even with growth data (#1335 finding #2)", () => {
    // Regression for the old bug where compaction was requested whenever
    // >= 2 growth samples existed, regardless of the real prefix size.
    const r = calculateReserve(makeInput({
      contextWindow: 128_000,
      stableContextTokens: 5000,
      recentAtomicGrowthTokens: [800, 1200, 900, 1500, 1100],
    }));
    // historyBudget = 128000 - 4096 - 4096 - 2900 = 116908; 5000 + growthReserve
    // (P90=1500, capped) is far below that → no compaction.
    expect(r.compactionDue).toBe(false);
  });

  it("compactionDue is true only when the measured stable prefix overflows the budget (#1335 finding #2)", () => {
    // Shrink the window so the real stable prefix (20000) + reserve overflows.
    const r = calculateReserve(makeInput({
      contextWindow: 30_000,
      stableContextTokens: 20_000,
      recentAtomicGrowthTokens: [1500, 1600],
    }));
    // usableInput = 30000 - 4096 - 4096 = 21808
    // historyBudget = 21808 - (500+2000+300+100) = 18908
    // growthReserve = P90 of [1500,1600] capped at 3000 = 1600
    // 20000 + 1600 = 21600 > 18908 → compaction due
    expect(r.historyBudget).toBeLessThan(20_000 + r.growthReserve);
    expect(r.compactionDue).toBe(true);
    expect(r.reason).toMatch(/history budget insufficient/);
  });

  it("compactionDue is false with unknown context window", () => {
    const r = calculateReserve(makeInput({ contextWindow: 0 }));
    expect(r.compactionDue).toBe(false);
  });

  it("returns zero values for unknown context window", () => {
    const r = calculateReserve(makeInput({ contextWindow: -1 }));
    expect(r.usableInput).toBe(0);
    expect(r.historyBudget).toBe(0);
  });

  it("proportionalSafetyMargin scales with context window", () => {
    expect(proportionalSafetyMargin(128_000)).toBe(3840);
    expect(proportionalSafetyMargin(8_000)).toBe(2048); // floor at 2048
    expect(proportionalSafetyMargin(0)).toBe(4096); // default for unknown
  });
});
