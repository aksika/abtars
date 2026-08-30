import { describe, expect, it } from "vitest";
import {
  ProviderExecutionError,
  isContextOverflowFailure,
  isCreditsExhausted,
  isProviderExecutionError,
  TERMINAL_FAILURE_CODES,
} from "./provider-failure.js";

describe("provider-failure contract (#1297, #1745)", () => {
  it("declares credits_exhausted and context_overflow as terminal codes", () => {
    expect(TERMINAL_FAILURE_CODES).toEqual(["credits_exhausted", "context_overflow"]);
  });

  it("isContextOverflowFailure matches a ProviderExecutionError with code context_overflow", () => {
    const err = new ProviderExecutionError({
      code: "context_overflow",
      retryable: false,
      attemptedCandidates: 2,
      message: "The request exceeds the context window of every configured model",
    });
    expect(isContextOverflowFailure(err)).toBe(true);
    expect(isProviderExecutionError(err)).toBe(true);
  });

  it("isContextOverflowFailure is false for credits_exhausted", () => {
    const err = new ProviderExecutionError({
      code: "credits_exhausted",
      retryable: false,
      attemptedCandidates: 1,
      message: "All model candidates are blocked by provider credit exhaustion",
    });
    expect(isContextOverflowFailure(err)).toBe(false);
    expect(isCreditsExhausted(err)).toBe(true);
  });

  it("isContextOverflowFailure is false for a plain Error", () => {
    expect(isContextOverflowFailure(new Error("context window exceeded"))).toBe(false);
  });

  it("isContextOverflowFailure is false for a non-error value", () => {
    expect(isContextOverflowFailure("context window")).toBe(false);
    expect(isContextOverflowFailure(undefined)).toBe(false);
    expect(isContextOverflowFailure({ failure: { code: "context_overflow" } })).toBe(false);
  });
});