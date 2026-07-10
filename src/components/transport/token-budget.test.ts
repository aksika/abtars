import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clampMaxOutputTokens, estimateTokensFromChars } from "./token-budget.js";
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
