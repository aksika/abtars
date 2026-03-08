// Feature: kiro-professor-webui, Property 13: Reconnect exponential backoff
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { getReconnectDelay } from "./dashboard-ui.js";

// **Validates: Requirements 12.4**

describe("getReconnectDelay — Property 13: Reconnect exponential backoff", () => {
  it("delay equals min(1000 * 2^(N-1), 30000) for any attempt N >= 1", () => {
    fc.assert(
      fc.property(fc.nat({ max: 20 }), (n) => {
        const attempt = n + 1; // ensure N >= 1
        const delay = getReconnectDelay(attempt);
        const expected = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        expect(delay).toBe(expected);
      }),
    );
  });

  it("delay never exceeds 30 000 ms", () => {
    fc.assert(
      fc.property(fc.nat({ max: 20 }), (n) => {
        const attempt = n + 1;
        expect(getReconnectDelay(attempt)).toBeLessThanOrEqual(30000);
      }),
    );
  });

  it("first attempt (N=1) always returns 1000 ms", () => {
    expect(getReconnectDelay(1)).toBe(1000);
  });

  it("delay is monotonically non-decreasing", () => {
    fc.assert(
      fc.property(fc.nat({ max: 19 }), (n) => {
        const attempt = n + 1;
        expect(getReconnectDelay(attempt + 1)).toBeGreaterThanOrEqual(
          getReconnectDelay(attempt),
        );
      }),
    );
  });
});
