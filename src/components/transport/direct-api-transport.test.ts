import { describe, it, expect, vi, beforeEach } from "vitest";
import { FallbackPolicy } from "./fallback-policy.js";
import { ModelHealthRegistry } from "./model-health-registry.js";

// Test the policy-driven fallback logic through the policy itself,
// since DirectApiTransport.sendWithPolicy is tightly coupled to HTTP streaming.
// The policy is the unit under test; transport integration is verified manually.

describe("FallbackPolicy — fallback sequence", () => {
  let registry: ModelHealthRegistry;

  beforeEach(() => { registry = new ModelHealthRegistry(); });

  it("simulates full fallback: primary fails, secondary succeeds", () => {
    const policy = new FallbackPolicy([
      { model: "kimi", endpoint: "ep1", maxContext: 128000 },
      { model: "nemotron", endpoint: "ep1", maxContext: 128000 },
    ], registry);

    // First select: kimi
    const first = policy.selectModel();
    expect(first?.model).toBe("kimi");

    // kimi fails
    policy.recordError(first!, "rate_limit", 5000);

    // Second select: skips kimi (bucketed), picks nemotron
    const second = policy.selectModel();
    expect(second?.model).toBe("nemotron");
    expect(policy.lastDecision?.skipped.length).toBe(1);

    // nemotron succeeds
    policy.recordSuccess(second!);
    expect(registry.getBucketLevel("nemotron", "ep1")).toBe(0);
  });

  it("simulates all-exhausted: both candidates fail", () => {
    const policy = new FallbackPolicy([
      { model: "kimi", endpoint: "ep1", maxContext: 128000 },
      { model: "nemotron", endpoint: "ep1", maxContext: 128000 },
    ], registry);

    // Both fail with auth
    policy.recordError({ model: "kimi", endpoint: "ep1", maxContext: 128000 }, "auth");
    policy.recordError({ model: "nemotron", endpoint: "ep1", maxContext: 128000 }, "auth");

    expect(policy.selectModel()).toBeNull();
    expect(policy.survivingCandidates()).toEqual([]);
  });

  it("shared registry: error on kimi affects all policies", () => {
    const policy1 = new FallbackPolicy([
      { model: "kimi", endpoint: "ep1", maxContext: 128000 },
    ], registry);
    const policy2 = new FallbackPolicy([
      { model: "kimi", endpoint: "ep1", maxContext: 128000 },
      { model: "backup", endpoint: "ep2", maxContext: 64000 },
    ], registry);

    // policy1 records auth error on kimi
    policy1.recordError({ model: "kimi", endpoint: "ep1", maxContext: 128000 }, "auth");

    // policy2 sees kimi as exhausted, falls back to backup
    const selected = policy2.selectModel();
    expect(selected?.model).toBe("backup");
  });
});
