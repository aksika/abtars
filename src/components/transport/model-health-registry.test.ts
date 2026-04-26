import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModelHealthRegistry, classifyError } from "./model-health-registry.js";

describe("ModelHealthRegistry", () => {
  let reg: ModelHealthRegistry;

  beforeEach(() => { reg = new ModelHealthRegistry(); });

  it("healthy model is not skipped", () => {
    expect(reg.shouldSkip("kimi", "ep1")).toBe(false);
  });

  it("skips after enough errors", () => {
    reg.recordError("kimi", "ep1", "transient");
    reg.recordError("kimi", "ep1", "transient");
    reg.recordError("kimi", "ep1", "transient"); // 0.1+0.2+0.4 = 0.7
    expect(reg.shouldSkip("kimi", "ep1")).toBe(true);
  });

  it("success resets consecutive errors", () => {
    reg.recordError("kimi", "ep1", "transient");
    reg.recordError("kimi", "ep1", "transient");
    reg.recordSuccess("kimi", "ep1");
    // Next error starts from idx 0 again
    reg.recordError("kimi", "ep1", "transient"); // 0.1 + existing level
    expect(reg.shouldSkip("kimi", "ep1")).toBe(false);
  });

  it("auth error is sticky — always skipped", () => {
    reg.recordError("kimi", "ep1", "auth");
    expect(reg.shouldSkip("kimi", "ep1")).toBe(true);
    // Even after time passes, auth stays sticky
    const health = reg.getHealth();
    expect(health.get("ep1|kimi")?.status).toBe("auth_failed");
  });

  it("auth clears on explicit success — but bucket still full", () => {
    reg.recordError("kimi", "ep1", "auth");
    reg.recordSuccess("kimi", "ep1");
    // Auth flag cleared, but bucket level is still 1.0 — will drain over time
    const health = reg.getHealth();
    expect(health.get("ep1|kimi")?.status).not.toBe("auth_failed");
  });

  it("weak error adds fill", () => {
    reg.recordError("kimi", "ep1", "weak");
    expect(reg.getBucketLevel("kimi", "ep1")).toBe(35); // 0.35 = 35%
  });

  it("cooldown skips until expired", () => {
    vi.useFakeTimers();
    reg.recordError("kimi", "ep1", "rate_limit", 5000);
    expect(reg.shouldSkip("kimi", "ep1")).toBe(true);
    vi.advanceTimersByTime(6000);
    // Still skipped due to bucket level, but cooldown expired
    const b = reg.getBucketLevel("kimi", "ep1");
    expect(b).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("getHealth returns structured data", () => {
    reg.recordError("kimi", "ep1", "transient");
    const health = reg.getHealth();
    const entry = health.get("ep1|kimi");
    expect(entry).toBeDefined();
    expect(entry!.consecutiveErrors).toBe(1);
    expect(entry!.status).toBe("healthy"); // 10% < 30% threshold
  });

  it("drains bucket over time", () => {
    vi.useFakeTimers();
    reg.recordError("kimi", "ep1", "transient");
    reg.recordError("kimi", "ep1", "transient");
    reg.recordError("kimi", "ep1", "transient"); // 70% — at threshold
    expect(reg.shouldSkip("kimi", "ep1")).toBe(true);
    vi.advanceTimersByTime(10 * 60 * 1000); // 10 min → drains 30%
    expect(reg.shouldSkip("kimi", "ep1")).toBe(false);
    vi.useRealTimers();
  });

  it("drain does not go below zero", () => {
    vi.useFakeTimers();
    reg.recordError("kimi", "ep1", "weak"); // 35%
    vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour
    expect(reg.getBucketLevel("kimi", "ep1")).toBe(0);
    vi.useRealTimers();
  });

  it("resetAll clears everything", () => {
    reg.recordError("kimi", "ep1", "transient");
    reg.resetAll();
    expect(reg.shouldSkip("kimi", "ep1")).toBe(false);
    expect(reg.getHealth().size).toBe(0);
  });
});

describe("classifyError", () => {
  it("429 → rate_limit", () => { expect(classifyError(429)).toBe("rate_limit"); });
  it("402 → rate_limit", () => { expect(classifyError(402)).toBe("rate_limit"); });
  it("401 → auth", () => { expect(classifyError(401)).toBe("auth"); });
  it("403 → auth", () => { expect(classifyError(403)).toBe("auth"); });
  it("500 → transient", () => { expect(classifyError(500)).toBe("transient"); });
});
