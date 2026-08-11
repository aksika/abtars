import { describe, it, expect } from "vitest";
import {
  computeEffectivePriority,
  isActiveLifecycle,
  deriveDeadline,
  resolveSchedulingPolicy,
  minDefined,
  SPIN_POLICY,
  PI_POLICY,
  REMOTE_POLICY,
} from "./swarm-dispatch-policy.js";

describe("computeEffectivePriority", () => {
  it("returns base for fresh cards", () => {
    const now = Date.now();
    const created = new Date(now).toISOString();
    expect(computeEffectivePriority("LOW", created, now)).toBe(0);
    expect(computeEffectivePriority("MEDIUM", created, now)).toBe(1);
    expect(computeEffectivePriority("HIGH", created, now)).toBe(2);
    expect(computeEffectivePriority("CRITICAL", created, now)).toBe(3);
  });

  it("promotes after age steps", () => {
    const now = Date.now();
    const old = new Date(now - 125_000).toISOString();
    expect(computeEffectivePriority("LOW", old, now)).toBe(2);
    expect(computeEffectivePriority("MEDIUM", old, now)).toBe(3);
  });

  it("caps at CRITICAL", () => {
    const now = Date.now();
    const veryOld = new Date(now - 600_000).toISOString();
    expect(computeEffectivePriority("LOW", veryOld, now)).toBe(3);
    expect(computeEffectivePriority("HIGH", veryOld, now)).toBe(3);
  });
});

describe("isActiveLifecycle", () => {
  it("returns true for nonterminal active lifecycles", () => {
    expect(isActiveLifecycle("claimed")).toBe(true);
    expect(isActiveLifecycle("starting")).toBe(true);
    expect(isActiveLifecycle("running")).toBe(true);
    expect(isActiveLifecycle("cancel_requested")).toBe(true);
  });

  it("returns false for pending and terminal lifecycles", () => {
    expect(isActiveLifecycle("pending")).toBe(false);
    expect(isActiveLifecycle("completed")).toBe(false);
    expect(isActiveLifecycle("failed")).toBe(false);
    expect(isActiveLifecycle("cancelled")).toBe(false);
    expect(isActiveLifecycle("timed_out")).toBe(false);
  });
});

describe("resolveSchedulingPolicy", () => {
  it("returns Spin policy for agent", () => {
    expect(resolveSchedulingPolicy("agent")).toEqual(SPIN_POLICY);
  });
  it("returns Pi policy", () => {
    expect(resolveSchedulingPolicy("pi")).toEqual(PI_POLICY);
  });
  it("returns Remote policy", () => {
    expect(resolveSchedulingPolicy("remote")).toEqual(REMOTE_POLICY);
  });
});

describe("deriveDeadline", () => {
  it("uses root hard deadline when present", () => {
    const claimedAt = "2026-07-30T12:00:00.000Z";
    const rootDeadline = "2026-07-30T12:05:00.000Z";
    const result = deriveDeadline(claimedAt, SPIN_POLICY, rootDeadline);
    expect(result).toBe(rootDeadline);
  });

  it("uses worker max_duration_ms when present", () => {
    const claimedAt = "2026-07-30T12:00:00.000Z";
    const result = deriveDeadline(claimedAt, SPIN_POLICY, undefined, 120_000);
    expect(result).toBe("2026-07-30T12:02:00.000Z");
  });

  it("uses executor default when nothing else is set", () => {
    const claimedAt = "2026-07-30T12:00:00.000Z";
    const result = deriveDeadline(claimedAt, SPIN_POLICY);
    expect(result).toBe("2026-07-30T12:30:00.000Z");
  });

  it("returns undefined for inspectable with no deadlines", () => {
    const claimedAt = "2026-07-30T12:00:00.000Z";
    const result = deriveDeadline(claimedAt, PI_POLICY);
    expect(result).toBeUndefined();
  });

  it("earliest wins", () => {
    const claimedAt = "2026-07-30T12:00:00.000Z";
    const result = deriveDeadline(claimedAt, SPIN_POLICY, "2026-07-30T12:01:00.000Z", 300_000);
    expect(result).toBe("2026-07-30T12:01:00.000Z");
  });
});

describe("minDefined", () => {
  it("returns minimum of defined values", () => {
    expect(minDefined(5, 3, 7)).toBe(3);
  });
  it("skips undefined and null", () => {
    expect(minDefined(undefined, 5, null, 3)).toBe(3);
  });
  it("returns undefined for no defined values", () => {
    expect(minDefined()).toBeUndefined();
  });
});
