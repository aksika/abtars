import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { routeReaction, formatReactionSignal } from "./reactions.js";

describe("routeReaction", () => {
  it("routes correctly based on authorization and chat type", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.oneof(fc.constant("private"), fc.constant("group"), fc.constant("supergroup"), fc.constant("channel")),
        (isAuthorized, chatType) => {
          const result = routeReaction(isAuthorized, chatType);
          if (!isAuthorized) expect(result).toBe("discard");
          else if (chatType === "group" || chatType === "supergroup") expect(result).toBe("buffer");
          else expect(result).toBe("transport");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("discards unauthorized", () => { expect(routeReaction(false, "private")).toBe("discard"); });
  it("buffers authorized group", () => { expect(routeReaction(true, "group")).toBe("buffer"); });
  it("transports authorized private", () => { expect(routeReaction(true, "private")).toBe("transport"); });
});

describe("formatReactionSignal", () => {
  it("formats [name reaction: emojis]", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 5 }),
        (name, emojis) => {
          const result = formatReactionSignal(name, emojis);
          expect(result).toBe(`[${name} reaction: ${emojis.join(" ")}]`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("single emoji", () => { expect(formatReactionSignal("Alice", ["👍"])).toBe("[Alice reaction: 👍]"); });
  it("multiple emojis", () => { expect(formatReactionSignal("Bob", ["👍", "🔥"])).toBe("[Bob reaction: 👍 🔥]"); });
  it("unicode name", () => { expect(formatReactionSignal("János", ["❤️"])).toBe("[János reaction: ❤️]"); });
});
