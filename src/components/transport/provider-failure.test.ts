import { describe, expect, it } from "vitest";
import {
  ProviderExecutionError,
  isAllCandidatesFailed,
  isContextOverflowFailure,
  isCreditsExhausted,
  isProviderExecutionError,
  isProviderUnavailable,
  TERMINAL_FAILURE_CODES,
} from "./provider-failure.js";

describe("provider-failure contract (#1297, #1745)", () => {
  it("declares credits_exhausted, context_overflow, all_candidates_failed, and provider_unavailable as terminal codes", () => {
    expect(TERMINAL_FAILURE_CODES).toEqual([
      "credits_exhausted",
      "context_overflow",
      "all_candidates_failed",
      "provider_unavailable",
    ]);
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

  it("isProviderUnavailable matches only the provider_unavailable code (#1932)", () => {
    const err = new ProviderExecutionError({
      code: "provider_unavailable",
      retryable: false,
      attemptedCandidates: 2,
      message: "All configured providers are cooling down",
    });
    expect(isProviderUnavailable(err)).toBe(true);
    expect(isAllCandidatesFailed(err)).toBe(false);
    expect(isProviderUnavailable(new Error("provider unavailable"))).toBe(false);
  });

  it("isContextOverflowFailure is false for a non-error value", () => {
    expect(isContextOverflowFailure("context window")).toBe(false);
    expect(isContextOverflowFailure(undefined)).toBe(false);
    expect(isContextOverflowFailure({ failure: { code: "context_overflow" } })).toBe(false);
  });

  it("isAllCandidatesFailed matches only the generic exhaustion code (#1905)", () => {
    const generic = new ProviderExecutionError({
      code: "all_candidates_failed",
      retryable: false,
      attemptedCandidates: 0,
      message: "All model candidates failed",
    });
    expect(isAllCandidatesFailed(generic)).toBe(true);
    expect(isProviderExecutionError(generic)).toBe(true);
    expect(isCreditsExhausted(generic)).toBe(false);
    expect(isContextOverflowFailure(generic)).toBe(false);
  });
});