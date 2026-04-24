import { describe, it, expect, beforeEach } from "vitest";
import { FallbackPolicy, type ModelCandidate } from "./fallback-policy.js";
import { ModelHealthRegistry } from "./model-health-registry.js";

function makeCandidates(): ModelCandidate[] {
  return [
    { model: "kimi", endpoint: "ep1", apiKey: "k1", maxContext: 128000 },
    { model: "nemotron", endpoint: "ep1", apiKey: "k1", maxContext: 128000 },
    { model: "gemini-flash", endpoint: "ep2", apiKey: "k2", maxContext: 1000000, lastResort: true },
  ];
}

describe("FallbackPolicy", () => {
  let reg: ModelHealthRegistry;
  let policy: FallbackPolicy;

  beforeEach(() => {
    reg = new ModelHealthRegistry();
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
    expect(policy.lastDecision?.skipped).toEqual(["kimi: bucket 70%"]);
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
