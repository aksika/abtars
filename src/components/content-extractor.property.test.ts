import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { extractTextFromHtml } from "./content-extractor.js";

/**
 * Feature: playwright-web-ingestion, Property 4: ContentExtractor produces clean text
 *
 * For any HTML string, the output of extractTextFromHtml() contains no HTML tags,
 * no content from script/style/nav/footer/header/aside elements, no consecutive
 * whitespace characters (spaces, tabs, newlines are collapsed to single separators),
 * and all common HTML entities are decoded to their plain text equivalents.
 *
 * Validates: Requirements 5.3, 14.2, 17.1, 17.2, 17.3, 17.4
 */

// ── Generators ──────────────────────────────────────────────────────────────

/** Tags whose content should be completely stripped from output. */
const STRIPPED_TAGS = ["script", "style", "nav", "footer", "header", "aside"] as const;

/** Generate a random plain text string (no angle brackets or ampersands). */
const safeText = fc.stringOf(
  fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?-"),
  { minLength: 1, maxLength: 40 },
);

/** Generate content wrapped in a stripped tag. */
const strippedElement = fc.tuple(
  fc.constantFrom(...STRIPPED_TAGS),
  safeText,
).map(([tag, content]) => `<${tag}>${content}</${tag}>`);

/** Generate a simple content element (p, div, span, article). */
const contentElement = fc.tuple(
  fc.constantFrom("p", "div", "span", "article", "section", "main"),
  safeText,
).map(([tag, content]) => `<${tag}>${content}</${tag}>`);

/** Generate an HTML entity and its expected decoded value. */
const htmlEntity = fc.constantFrom(
  { encoded: "&amp;", decoded: "&" },
  { encoded: "&lt;", decoded: "<" },
  { encoded: "&gt;", decoded: ">" },
  { encoded: "&quot;", decoded: '"' },
  { encoded: "&#39;", decoded: "'" },
  { encoded: "&nbsp;", decoded: " " },
);

/** Generate a random HTML document mixing content and stripped elements. */
const randomHtmlDoc = fc.tuple(
  fc.array(contentElement, { minLength: 1, maxLength: 5 }),
  fc.array(strippedElement, { minLength: 0, maxLength: 5 }),
).map(([contentEls, strippedEls]) => {
  // Interleave content and stripped elements
  const all = [...contentEls, ...strippedEls];
  // Shuffle deterministically by just alternating
  const shuffled: string[] = [];
  for (let i = 0; i < Math.max(contentEls.length, strippedEls.length); i++) {
    if (i < contentEls.length) shuffled.push(contentEls[i]);
    if (i < strippedEls.length) shuffled.push(strippedEls[i]);
  }
  return `<html><body>${shuffled.join("\n")}</body></html>`;
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Feature: playwright-web-ingestion, Property 4: ContentExtractor produces clean text", () => {
  it("output contains no HTML tags", () => {
    fc.assert(
      fc.property(randomHtmlDoc, (html) => {
        const result = extractTextFromHtml(html);
        // No HTML tags should remain in output
        expect(result).not.toMatch(/<[^>]+>/);
      }),
      { numRuns: 100 },
    );
  });

  it("output contains no content from stripped elements (script/style/nav/footer/header/aside)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STRIPPED_TAGS),
        safeText,
        (tag, innerText) => {
          // Ensure inner text is unique enough to detect
          const marker = `UNIQUE_MARKER_${innerText.trim()}`;
          const html = `<p>visible content</p><${tag}>${marker}</${tag}>`;
          const result = extractTextFromHtml(html);

          expect(result).not.toContain(marker);
          expect(result).toContain("visible content");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("output has no consecutive whitespace (spaces collapsed)", () => {
    fc.assert(
      fc.property(randomHtmlDoc, (html) => {
        const result = extractTextFromHtml(html);
        if (result.length === 0) return; // empty is fine

        // No consecutive spaces
        expect(result).not.toMatch(/  /);
        // No consecutive newlines
        expect(result).not.toMatch(/\n\n/);
        // No tabs (should be collapsed to spaces)
        expect(result).not.toMatch(/\t/);
        // No leading/trailing whitespace on lines
        expect(result).not.toMatch(/^ /m);
        expect(result).not.toMatch(/ $/m);
      }),
      { numRuns: 100 },
    );
  });

  it("all common HTML entities are decoded", () => {
    fc.assert(
      fc.property(htmlEntity, ({ encoded, decoded }) => {
        const html = `<p>before${encoded}after</p>`;
        const result = extractTextFromHtml(html);

        // The decoded character should appear in the output
        expect(result).toContain(`before${decoded}after`);
        // The encoded entity should NOT appear in the output
        expect(result).not.toContain(encoded);
      }),
      { numRuns: 100 },
    );
  });

  it("random HTML with mixed stripped and content elements produces clean output", () => {
    fc.assert(
      fc.property(
        fc.array(strippedElement, { minLength: 1, maxLength: 4 }),
        fc.array(contentElement, { minLength: 1, maxLength: 4 }),
        (stripped, content) => {
          const html = `<html><body>${[...stripped, ...content].join("")}</body></html>`;
          const result = extractTextFromHtml(html);

          // No HTML tags
          expect(result).not.toMatch(/<[^>]+>/);

          // No consecutive spaces or newlines
          if (result.length > 0) {
            expect(result).not.toMatch(/  /);
            expect(result).not.toMatch(/\n\n/);
            expect(result).not.toMatch(/\t/);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("empty and whitespace-only HTML returns empty string", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("", "   ", "\n\t\n", "  \n  "),
        (html) => {
          expect(extractTextFromHtml(html)).toBe("");
        },
      ),
      { numRuns: 100 },
    );
  });
});
