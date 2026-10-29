import { describe, expect, it } from "vitest";
import { ProviderExecutionError, isProviderExecutionError, terminalFailureCodeFor } from "./provider-failure.js";

describe("provider-failure contract (#1297, #1940)", () => {
  it("classifies Pi's final quota/billing error as credits_exhausted (SHA self-heal gate)", () => {
    expect(terminalFailureCodeFor("429 insufficient_quota: You exceeded your current quota")).toBe("credits_exhausted");
    expect(terminalFailureCodeFor("402 Insufficient credits")).toBe("credits_exhausted");
  });

  it("reports every other final provider error as all_candidates_failed", () => {
    expect(terminalFailureCodeFor("503 Service Unavailable")).toBe("all_candidates_failed");
    expect(terminalFailureCodeFor("prompt is too long: 213462 tokens > 200000 maximum")).toBe("all_candidates_failed");
  });

  it("identifies typed provider failures by type, not message", () => {
    const err = new ProviderExecutionError({
      code: "all_candidates_failed",
      retryable: false,
      attemptedCandidates: 1,
      message: "credits",
    });
    expect(isProviderExecutionError(err)).toBe(true);
    expect(isProviderExecutionError(new Error("credits exhausted"))).toBe(false);
  });
});
