/**
 * Feature: playwright-web-ingestion, Property 14: URL auto-detection
 *
 * For any string passed to the /ingest command:
 * - If it starts with http:// or https:// and the hostname matches
 *   youtube.com, www.youtube.com, m.youtube.com, or youtu.be → "youtube"
 * - If it starts with http:// or https:// and hostname does NOT match
 *   any YouTube domain → "webpage"
 * - If it does not start with http:// or https:// → existing file-extension
 *   detection logic applies (.pdf → "pdf", .md → "markdown", else → "text")
 *
 * Validates: Requirements 13.1, 13.2, 13.3
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { detectIngestSourceType } from "./ingest-source-detect.js";

const YOUTUBE_HOSTNAMES = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"];

/** Arbitrary: random YouTube URL. */
const youtubeUrlArb = fc
  .record({
    protocol: fc.constantFrom("http://", "https://"),
    host: fc.constantFrom(...YOUTUBE_HOSTNAMES),
    path: fc.stringOf(fc.constantFrom("a", "b", "/", "?", "=", "v", "1"), {
      minLength: 0,
      maxLength: 20,
    }),
  })
  .map(({ protocol, host, path }) => `${protocol}${host}/${path}`);

/** Arbitrary: random non-YouTube HTTP URL. */
const nonYoutubeUrlArb = fc
  .record({
    protocol: fc.constantFrom("http://", "https://"),
    host: fc.stringOf(fc.constantFrom("a", "b", "c", "d", "e"), {
      minLength: 1,
      maxLength: 8,
    }),
    tld: fc.constantFrom(".com", ".org", ".net", ".io", ".dev"),
    path: fc.stringOf(fc.constantFrom("a", "/", "-", "1"), {
      minLength: 0,
      maxLength: 15,
    }),
  })
  .map(({ protocol, host, tld, path }) => `${protocol}${host}${tld}/${path}`);

/** Arbitrary: random file path (non-HTTP). */
const filePathArb = fc
  .record({
    dir: fc.stringOf(fc.constantFrom("a", "b", "/", "_"), {
      minLength: 1,
      maxLength: 10,
    }),
    ext: fc.constantFrom(".pdf", ".md", ".txt", ".csv", ".json", ""),
  })
  .map(({ dir, ext }) => `${dir}${ext}`);

describe("Feature: playwright-web-ingestion, Property 14: URL auto-detection", () => {
  it("YouTube URLs are detected as 'youtube'", () => {
    fc.assert(
      fc.property(youtubeUrlArb, (url) => {
        expect(detectIngestSourceType(url)).toBe("youtube");
      }),
      { numRuns: 100 },
    );
  });

  it("non-YouTube HTTP/HTTPS URLs are detected as 'webpage'", () => {
    fc.assert(
      fc.property(nonYoutubeUrlArb, (url) => {
        expect(detectIngestSourceType(url)).toBe("webpage");
      }),
      { numRuns: 100 },
    );
  });

  it("non-HTTP strings use file-extension detection", () => {
    fc.assert(
      fc.property(filePathArb, (path) => {
        const result = detectIngestSourceType(path);
        if (path.endsWith(".pdf")) {
          expect(result).toBe("pdf");
        } else if (path.endsWith(".md")) {
          expect(result).toBe("markdown");
        } else {
          expect(result).toBe("text");
        }
      }),
      { numRuns: 100 },
    );
  });

  it("handles edge cases: empty string, plain text, ftp://", () => {
    expect(detectIngestSourceType("")).toBe("text");
    expect(detectIngestSourceType("hello world")).toBe("text");
    expect(detectIngestSourceType("ftp://example.com")).toBe("text");
    expect(detectIngestSourceType("httpnotaurl")).toBe("text");
  });
});
