// Feature: telegram-enhancements, Property 3: Reaction routing by authorization and chat type
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { routeReaction } from "./reaction-router.js";

describe("routeReaction — Property 3: Reaction routing by authorization and chat type", () => {
  /**
   * Validates: Requirements 4.2, 5.1, 5.2
   *
   * For any combination of authorization status and chat type,
   * the routing destination matches:
   * - NOT authorized → "discard"
   * - authorized AND group/supergroup → "buffer"
   * - authorized AND anything else → "transport"
   */
  it("routes reactions correctly based on authorization and chat type", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.oneof(
          fc.constant("private"),
          fc.constant("group"),
          fc.constant("supergroup"),
          fc.constant("channel"),
        ),
        (isAuthorized, chatType) => {
          const result = routeReaction(isAuthorized, chatType);

          if (!isAuthorized) {
            expect(result).toBe("discard");
          } else if (chatType === "group" || chatType === "supergroup") {
            expect(result).toBe("buffer");
          } else {
            expect(result).toBe("transport");
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("routeReaction — Unit tests", () => {
  it("discards unauthorized reactions in private chat", () => {
    expect(routeReaction(false, "private")).toBe("discard");
  });

  it("discards unauthorized reactions in group chat", () => {
    expect(routeReaction(false, "group")).toBe("discard");
  });

  it("routes authorized private chat to transport", () => {
    expect(routeReaction(true, "private")).toBe("transport");
  });

  it("routes authorized group chat to buffer", () => {
    expect(routeReaction(true, "group")).toBe("buffer");
  });

  it("routes authorized supergroup chat to buffer", () => {
    expect(routeReaction(true, "supergroup")).toBe("buffer");
  });

  it("routes authorized channel chat to transport (fallback)", () => {
    expect(routeReaction(true, "channel")).toBe("transport");
  });
});
