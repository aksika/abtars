import { describe, it, expect, vi } from "vitest";
import { withRetry, isFatal } from "../components/retry.js";

describe("withRetry", () => {
  it("succeeds on first attempt", async () => {
    const result = await withRetry(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("succeeds on second attempt", async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return Promise.resolve("ok");
    }, { minDelayMs: 1, maxDelayMs: 1 });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("stops on fatal error", async () => {
    await expect(withRetry(
      () => { throw new Error("auth failed: invalid key"); },
      { attempts: 5, minDelayMs: 1 },
    )).rejects.toThrow("auth failed");
  });

  it("respects delay hint from error", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(() => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("rate limit"), { retryAfter: 50 });
      return Promise.resolve("ok");
    }, {
      minDelayMs: 1,
      getDelayHint: (err) => (err as { retryAfter?: number }).retryAfter,
      onAttempt: (info) => delays.push(info.delayMs),
    });
    // Delay hints should be ~50ms (±jitter)
    for (const d of delays) expect(d).toBeGreaterThan(30);
  });

  it("calls onAttempt before each retry", async () => {
    const attempts: number[] = [];
    let calls = 0;
    await withRetry(() => {
      calls++;
      if (calls < 3) throw new Error("fail");
      return Promise.resolve("ok");
    }, {
      minDelayMs: 1,
      onAttempt: (info) => attempts.push(info.attempt),
    });
    expect(attempts).toEqual([1, 2]);
  });

  it("throws after exhausting attempts", async () => {
    await expect(withRetry(
      () => { throw new Error("always fails"); },
      { attempts: 3, minDelayMs: 1, isRecoverable: () => true },
    )).rejects.toThrow("always fails");
  });
});

describe("isFatal", () => {
  it("detects auth errors", () => {
    expect(isFatal(new Error("auth failed: invalid key"))).toBe(true);
    expect(isFatal(new Error("unauthorized access"))).toBe(true);
  });

  it("detects model errors", () => {
    expect(isFatal(new Error("model not found for API"))).toBe(true);
  });

  it("passes transient errors", () => {
    expect(isFatal(new Error("timeout"))).toBe(false);
    expect(isFatal(new Error("connection reset"))).toBe(false);
    expect(isFatal(new Error("-32603 internal error"))).toBe(false);
  });
});
