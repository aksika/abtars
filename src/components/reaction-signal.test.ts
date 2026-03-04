// Feature: telegram-enhancements, Property 2: Reaction signal formatting
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { formatReactionSignal } from "./reaction-signal.js";

describe("formatReactionSignal — Property 2: Reaction signal formatting", () => {
  /**
   * Validates: Requirements 3.1, 3.2, 3.3, 4.4, 5.3
   *
   * For any sender display name and any non-empty list of emoji characters,
   * formatReactionSignal(name, emojis) SHALL produce a string matching the
   * pattern [<name> reaction: <emoji1> <emoji2> ...] where each emoji appears
   * as the raw character separated by spaces, and the sender name appears verbatim.
   */
  it("output matches [<name> reaction: <emojis>] pattern for any inputs", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 5 }),
        (senderName, emojis) => {
          const result = formatReactionSignal(senderName, emojis);

          // 1. Output starts with [ and ends with ]
          expect(result.startsWith("[")).toBe(true);
          expect(result.endsWith("]")).toBe(true);

          // 2. Output contains the sender name verbatim
          expect(result).toContain(senderName);

          // 3. Output contains " reaction: " between name and emojis
          expect(result).toContain(`${senderName} reaction: `);

          // 4. Each emoji appears in the output as a raw character
          for (const emoji of emojis) {
            expect(result).toContain(emoji);
          }

          // 5. Emojis are separated by spaces — the joined emojis substring matches
          const expectedEmojiPart = emojis.join(" ");
          expect(result).toBe(`[${senderName} reaction: ${expectedEmojiPart}]`);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("formatReactionSignal — Unit tests", () => {
  it("formats single emoji correctly", () => {
    expect(formatReactionSignal("Alice", ["👍"])).toBe("[Alice reaction: 👍]");
  });

  it("formats multiple emojis with space separation", () => {
    expect(formatReactionSignal("Bob", ["👍", "🔥"])).toBe("[Bob reaction: 👍 🔥]");
  });

  it("preserves first_name as display name", () => {
    expect(formatReactionSignal("János", ["❤️"])).toBe("[János reaction: ❤️]");
  });

  it("works with username-style display name", () => {
    expect(formatReactionSignal("john_doe", ["👍"])).toBe("[john_doe reaction: 👍]");
  });

  it("works with id: fallback display name", () => {
    expect(formatReactionSignal("id:12345", ["🎉"])).toBe("[id:12345 reaction: 🎉]");
  });
});
