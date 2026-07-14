import { describe, it, expect } from "vitest";
import {
  buildCandidates,
  candidateIdentityKey,
  deduplicateCandidates,
  type ModelCandidate,
} from "./model-candidates.js";

function cand(model: string, provider: string, endpoint: string, maxContext = 128000, source: ModelCandidate["source"] = "primary"): ModelCandidate {
  return { model, provider, endpoint, maxContext, source };
}

describe("candidateIdentityKey (#1418)", () => {
  it("keys by provider/model/endpoint", () => {
    expect(candidateIdentityKey({ model: "m", provider: "p", endpoint: "e" })).toBe("p/m@e");
  });
  it("treats same model on different providers as distinct", () => {
    expect(candidateIdentityKey({ model: "m", provider: "p1", endpoint: "e" })).not.toBe(
      candidateIdentityKey({ model: "m", provider: "p2", endpoint: "e" }),
    );
  });
});

describe("deduplicateCandidates (#1418)", () => {
  it("drops exact provider/model/endpoint duplicates keeping first occurrence", () => {
    const { candidates, diagnostics } = deduplicateCandidates([
      cand("m", "p", "e", 128000, "primary"),
      cand("m", "p", "e", 200000, "agent_fallback"),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.source).toBe("primary");
    expect(diagnostics).toHaveLength(1);
  });

  it("keeps same model on different providers", () => {
    const { candidates } = deduplicateCandidates([
      cand("m", "p1", "e"),
      cand("m", "p2", "e"),
    ]);
    expect(candidates).toHaveLength(2);
  });
});

describe("buildCandidates (#1418)", () => {
  const configuredMain = cand("main-model", "openrouter", "https://or/api/v1", 128000);
  const fb1 = cand("fb-one", "ollama", "http://ollama/v1", 64000);
  const fb2 = cand("fb-two", "openrouter", "https://or/api/v1", 128000);

  it("Main: configured → fallback chain, in order", () => {
    const result = buildCandidates({ role: "main", configured: configuredMain, fallbacks: [fb1, fb2] });
    expect(result.map(c => c.model)).toEqual(["main-model", "fb-one", "fb-two"]);
    expect(result[0]!.source).toBe("primary");
    expect(result[1]!.source).toBe("agent_fallback");
  });

  it("specialist: configured role → last successful Main → fallback chain", () => {
    const specialist = cand("sleep-model", "openrouter", "https://or/api/v1", 100000);
    const lastMain = cand("recovered-model", "ollama", "http://ollama/v1", 64000);
    const result = buildCandidates({ role: "specialist", configured: specialist, lastSuccessfulMain: lastMain, fallbacks: [fb1, fb2] });
    expect(result.map(c => c.model)).toEqual(["sleep-model", "recovered-model", "fb-one", "fb-two"]);
    expect(result[1]!.provider).toBe("ollama");
    expect(result[1]!.source).toBe("inherited_chain");
  });

  it("specialist: no last-successful Main → inherited position omitted (caller passes configured Main)", () => {
    const specialist = cand("sleep-model", "openrouter", "https://or/api/v1", 100000);
    const result = buildCandidates({ role: "specialist", configured: specialist, lastSuccessfulMain: null, fallbacks: [fb1] });
    expect(result.map(c => c.model)).toEqual(["sleep-model", "fb-one"]);
  });

  it("dedups when configured role equals last successful Main (same provider/model/endpoint)", () => {
    const specialist = cand("shared", "openrouter", "https://or/api/v1", 100000);
    const lastMain = cand("shared", "openrouter", "https://or/api/v1", 100000);
    const result = buildCandidates({ role: "specialist", configured: specialist, lastSuccessfulMain: lastMain, fallbacks: [] });
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("primary");
  });

  it("preserves first occurrence order across specialist + inherited + chain", () => {
    const specialist = cand("m1", "p1", "e1");
    const lastMain = cand("m2", "p2", "e2");
    const chain = [cand("m3", "p3", "e3"), cand("m1", "p1", "e1") /* dup of configured */];
    const result = buildCandidates({ role: "specialist", configured: specialist, lastSuccessfulMain: lastMain, fallbacks: chain });
    expect(result.map(c => `${c.model}/${c.provider}`)).toEqual(["m1/p1", "m2/p2", "m3/p3"]);
  });
});
