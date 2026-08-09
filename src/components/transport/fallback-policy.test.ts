import { describe, it, expect, beforeEach } from "vitest";
import { FallbackPolicy, type ModelCandidate } from "./fallback-policy.js";
import { ModelHealthRegistry } from "./model-health-registry.js";

function makeCandidates(): ModelCandidate[] {
  return [
    { model: "kimi", endpoint: "ep1", apiKey: "k1", maxContext: 128000 },
    { model: "nemotron", endpoint: "ep1", apiKey: "k1", maxContext: 128000 },
    { model: "gemini-flash", endpoint: "ep2", apiKey: "k2", maxContext: 1000000 },
  ];
}

describe("FallbackPolicy", () => {
  let reg: ModelHealthRegistry;
  let policy: FallbackPolicy;

  beforeEach(() => {
    reg = new ModelHealthRegistry({ leakPerMinute: 0 });
    policy = new FallbackPolicy(makeCandidates(), reg);
  });

  it("selects first healthy candidate", () => {
    const c = policy.selectModel();
    expect(c?.model).toBe("kimi");
  });

  it("skips bucketed model, selects next", () => {
    reg.recordError("kimi", "ep1", "transient");
    reg.recordError("kimi", "ep1", "transient");
    reg.recordError("kimi", "ep1", "transient");
    const c = policy.selectModel();
    expect(c?.model).toBe("nemotron");
    expect(policy.lastDecision?.skipped[0]).toContain("kimi");
  });

  it("returns null when all exhausted", () => {
    for (const cand of makeCandidates()) {
      reg.recordError(cand.model, cand.endpoint, "auth");
    }
    expect(policy.selectModel()).toBeNull();
  });

  it("skips candidate with context too large", () => {
    const small = [{ model: "small", endpoint: "ep1", apiKey: "k1", maxContext: 1000 }];
    const p = new FallbackPolicy(small, reg);
    expect(p.selectModel(2000)).toBeNull();
  });

  it("survivingCandidates excludes bucketed", () => {
    reg.recordError("kimi", "ep1", "auth");
    const surviving = policy.survivingCandidates();
    expect(surviving.map(c => c.model)).toEqual(["nemotron", "gemini-flash"]);
  });

  it("recordSuccess delegates to registry", () => {
    const c = makeCandidates()[0]!;
    reg.recordError(c.model, c.endpoint, "transient");
    policy.recordSuccess(c);
    expect(reg.getBucketLevel(c.model, c.endpoint)).toBeGreaterThan(0); // level doesn't reset, just consecutive
  });
});

describe("FallbackPolicy allCandidatesCreditFailed (#1297)", () => {
  let reg: ModelHealthRegistry;
  let candidates: ModelCandidate[];

  beforeEach(() => {
    reg = new ModelHealthRegistry({ leakPerMinute: 0 });
    candidates = makeCandidates();
  });

  it("returns true when every candidate is sticky credit-failed", () => {
    const policy = new FallbackPolicy(candidates, reg);
    for (const cand of candidates) reg.recordError(cand.model, cand.endpoint, "credits");
    expect(policy.allCandidatesCreditFailed()).toBe(true);
  });

  it("returns false for a mix of credit and non-credit failures", () => {
    const policy = new FallbackPolicy(candidates, reg);
    reg.recordError(candidates[0]!.model, candidates[0]!.endpoint, "credits");
    reg.recordError(candidates[1]!.model, candidates[1]!.endpoint, "transient");
    reg.recordError(candidates[2]!.model, candidates[2]!.endpoint, "credits");
    expect(policy.allCandidatesCreditFailed()).toBe(false);
  });

  it("returns false when the list is empty", () => {
    const policy = new FallbackPolicy([], reg);
    expect(policy.allCandidatesCreditFailed()).toBe(false);
  });

  it("returns false when one candidate is viable", () => {
    const policy = new FallbackPolicy(candidates, reg);
    reg.recordError(candidates[0]!.model, candidates[0]!.endpoint, "credits");
    reg.recordError(candidates[1]!.model, candidates[1]!.endpoint, "credits");
    expect(policy.allCandidatesCreditFailed()).toBe(false);
  });

  it("returns false when the same model is credit-failed on one endpoint only", () => {
    const policy = new FallbackPolicy(candidates, reg);
    reg.recordError("kimi", "ep1", "credits");
    reg.recordError("nemotron", "ep1", "credits");
    expect(policy.allCandidatesCreditFailed()).toBe(false); // gemini-flash@ep2 still viable
  });

  it("clears to false after resetAll", () => {
    const policy = new FallbackPolicy(candidates, reg);
    for (const cand of candidates) reg.recordError(cand.model, cand.endpoint, "credits");
    expect(policy.allCandidatesCreditFailed()).toBe(true);
    reg.resetAll();
    expect(policy.allCandidatesCreditFailed()).toBe(false);
  });
});
