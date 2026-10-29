import { describe, it, expect } from "vitest";
import { estimateTokensFromChars } from "./token-budget.js";

describe("estimateTokensFromChars", () => {
  it("rounds up charCount/4 to a positive integer", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromChars(100)).toBe(25);
  });
});
