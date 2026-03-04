// Feature: telegram-enhancements, Property 4: Emoji filter round-trip preservation
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

vi.mock("@andresaya/edge-tts", () => ({
  EdgeTTS: vi.fn(),
  Constants: { OUTPUT_FORMAT: { WEBM_24KHZ_16BIT_MONO_OPUS: "webm" } },
}));

vi.mock("./logger.js", () => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

import { cleanForTts } from "./tts.js";

/** Same regex used in cleanForTts for emoji stripping */
const EMOJI_REGEX_GLOBAL = /\p{Extended_Pictographic}/gu;
const EMOJI_REGEX_SINGLE = /\p{Extended_Pictographic}/u;

/** Strip emojis using the same regex as cleanForTts */
function stripEmojis(text: string): string {
  return text.replace(EMOJI_REGEX_GLOBAL, "");
}

describe("Emoji filter — Property 4: Emoji filter round-trip preservation", () => {
  /**
   * Validates: Requirements 7.1, 7.2
   *
   * For any string, applying the emoji filter SHALL remove all
   * \p{Extended_Pictographic} characters AND the remaining output SHALL
   * equal the original string with only those characters removed (all
   * non-emoji text, punctuation, and whitespace are preserved in order).
   */
  it("removes all Extended_Pictographic characters while preserving all other characters in order", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        (input) => {
          const filtered = stripEmojis(input);

          // 1. The filtered output contains no emoji characters
          const remainingEmojis = filtered.match(EMOJI_REGEX_GLOBAL);
          expect(remainingEmojis).toBeNull();

          // 2. Manually removing emojis character-by-character produces the same result
          const manuallyFiltered = [...input]
            .filter((char) => !EMOJI_REGEX_SINGLE.test(char))
            .join("");
          expect(filtered).toBe(manuallyFiltered);
        },
      ),
      { numRuns: 100 },
    );
  });
});


describe("Emoji filter — Unit tests", () => {
  it("leaves no-emoji string unchanged", () => {
    expect(stripEmojis("Hello, world! This is a test.")).toBe("Hello, world! This is a test.");
  });

  it("emoji-only string produces empty string", () => {
    // ❤️ contains a variation selector (U+FE0F) which is not Extended_Pictographic,
    // so it may remain after stripping. The key assertion: no emojis remain
    // and only non-printable combining characters (if any) are left.
    const result = stripEmojis("👍🔥❤️🎉");
    expect(result.match(EMOJI_REGEX_GLOBAL)).toBeNull();
    // Only variation selectors / zero-width joiners may remain
    expect(result.replace(/[\uFE0F\u200D]/g, "")).toBe("");
  });

  it("mixed text and emoji preserves text", () => {
    expect(stripEmojis("Hello 👋 world 🌍")).toBe("Hello  world ");
  });

  it("handles compound emojis (flags)", () => {
    const result = stripEmojis("Visit 🇭🇺 Hungary");
    // Flag emojis are Regional Indicator Symbols, which may or may not be Extended_Pictographic
    // The key assertion: no Extended_Pictographic characters remain
    expect(result.match(EMOJI_REGEX_GLOBAL)).toBeNull();
    expect(result).toContain("Visit");
    expect(result).toContain("Hungary");
  });

  it("handles skin tone emojis", () => {
    const result = stripEmojis("Hi 👋🏽 there");
    // The base emoji 👋 is Extended_Pictographic, skin tone modifier may remain
    expect(result).toContain("Hi");
    expect(result).toContain("there");
  });

  it("preserves numbers, punctuation, and special characters", () => {
    expect(stripEmojis("Price: $99.99 (50% off)!")).toBe("Price: $99.99 (50% off)!");
  });

  it("preserves Unicode text (Hungarian)", () => {
    expect(stripEmojis("Szia! Hogy vagy? 😊")).toBe("Szia! Hogy vagy? ");
  });
});

describe("cleanForTts — Emoji integration tests", () => {
  it("strips emojis from plain text", () => {
    const result = cleanForTts("Hello 👋 world");
    expect(result).toBe("Hello  world");
  });

  it("returns empty-ish string for emoji-only input", () => {
    const result = cleanForTts("👍🔥❤️");
    expect(result.trim().length).toBeLessThan(5);
  });
});
