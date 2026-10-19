import { describe, expect, it } from "vitest";
import {
  ProviderExecutionError,
  classifyError,
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

describe("classifyError", () => {
  it("429 → rate_limit", () => { expect(classifyError(429)).toBe("rate_limit"); });
  it("402 → rate_limit", () => { expect(classifyError(402)).toBe("rate_limit"); });
  it("401 → auth", () => { expect(classifyError(401)).toBe("auth"); });
  it("403 → auth", () => { expect(classifyError(403)).toBe("auth"); });
  it("500 → transient", () => { expect(classifyError(500)).toBe("transient"); });
});

describe("classifyError quota exhaustion (#1753)", () => {
  it("429 + insufficient_quota → credits (exhausted billing is not retried forever)", () => {
    expect(classifyError(429, "429 insufficient_quota: You exceeded your current quota")).toBe("credits");
  });

  it("0 + quota text → credits (unparseable status from parseErrorStatus)", () => {
    expect(classifyError(0, "insufficient_quota: billing quota exceeded")).toBe("credits");
  });

  it("429 + plain rate-limit text → rate_limit (genuine throttling stays drainable)", () => {
    expect(classifyError(429, "Rate limit exceeded, please retry after 60s")).toBe("rate_limit");
  });

  it("500 + text mentioning billing → not credits (status gate guards healthy model)", () => {
    expect(classifyError(500, "billing service temporarily unavailable")).not.toBe("credits");
    expect(classifyError(500, "billing service temporarily unavailable")).toBe("transient");
  });

  it("402 + quota text → credits via quota branch", () => {
    expect(classifyError(402, "quota exceeded for this account")).toBe("credits");
  });

  it("429 + out of budget → credits", () => {
    expect(classifyError(429, "You are out of budget, please add funds")).toBe("credits");
  });

  it("429 without message → rate_limit (no quota string, no behavior change)", () => {
    expect(classifyError(429)).toBe("rate_limit");
    expect(classifyError(429, "")).toBe("rate_limit");
  });
});