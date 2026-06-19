import { describe, it, expect, beforeEach, vi } from "vitest";

vi.stubEnv("MAX_AGENT_CALL_PER_HOUR", "5");
vi.stubEnv("MAX_AGENT_CALL_PER_DAY", "10");

// Must import after env stub
const { checkRateLimit } = await import("./agent-api-rate-limit.js");

describe("checkRateLimit", () => {
  beforeEach(() => {
    // Reset module state by clearing the callers map via repeated calls with unique callers
  });

  it("allows calls within hourly limit", () => {
    const caller = `test-hourly-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(caller).allowed).toBe(true);
    }
  });

  it("blocks at hourly limit", () => {
    const caller = `test-block-${Date.now()}`;
    for (let i = 0; i < 5; i++) checkRateLimit(caller);
    const result = checkRateLimit(caller);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("different callers have independent limits", () => {
    const a = `caller-a-${Date.now()}`;
    const b = `caller-b-${Date.now()}`;
    for (let i = 0; i < 5; i++) checkRateLimit(a);
    expect(checkRateLimit(a).allowed).toBe(false);
    expect(checkRateLimit(b).allowed).toBe(true);
  });
});

describe("checkPeerPostLimit (#949)", () => {
  it("allows first call", async () => {
    const { checkPeerPostLimit } = await import("./agent-api-rate-limit.js");
    const peer = `peer-first-${Date.now()}`;
    expect(checkPeerPostLimit(peer)).toBe(true);
  });

  it("blocks within 10s window", async () => {
    const { checkPeerPostLimit } = await import("./agent-api-rate-limit.js");
    const peer = `peer-block-${Date.now()}`;
    expect(checkPeerPostLimit(peer)).toBe(true);
    expect(checkPeerPostLimit(peer)).toBe(false);
  });

  it("independent per peer", async () => {
    const { checkPeerPostLimit } = await import("./agent-api-rate-limit.js");
    const a = `peer-a-${Date.now()}`;
    const b = `peer-b-${Date.now()}`;
    expect(checkPeerPostLimit(a)).toBe(true);
    expect(checkPeerPostLimit(b)).toBe(true);
    expect(checkPeerPostLimit(a)).toBe(false);
    expect(checkPeerPostLimit(b)).toBe(false);
  });
});
