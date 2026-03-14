/**
 * Feature: playwright-web-ingestion, Property 1: CLI action validation
 *
 * For any string passed as the --action parameter, the CLI argument parser
 * accepts it if and only if it is one of: navigate, click, fill, extract_text,
 * screenshot, get_page_info, close_session. All other strings are rejected
 * with an error.
 *
 * **Validates: Requirements 1.2**
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseArgs, validateArgs } from "./agentbridge-browser.js";

const VALID_ACTIONS = [
  "navigate",
  "click",
  "fill",
  "extract_text",
  "screenshot",
  "get_page_info",
  "close_session",
] as const;

const VALID_ACTION_SET = new Set<string>(VALID_ACTIONS);

describe("agentbridge-browser — Property 1: CLI action validation", () => {
  /**
   * For any random string used as --action, it is accepted iff it is one of
   * the 7 valid action types. All others are rejected with an error.
   */
  it("accepts only the 7 valid action types and rejects all others", () => {
    fc.assert(
      fc.property(fc.string(), (actionStr) => {
        const raw = parseArgs(["node", "agentbridge-browser", "--action", actionStr]);
        const result = validateArgs(raw);

        if (VALID_ACTION_SET.has(actionStr)) {
          // Valid actions may still fail validation due to missing required
          // params (e.g. navigate needs --url), but they must NOT fail with
          // an "Invalid action" error.
          if (!result.ok) {
            expect(result.error).not.toContain("Invalid action");
          }
        } else {
          // Invalid actions (including empty string) must always be rejected.
          // The error may be "Invalid action" or "--action is required" for
          // empty/falsy strings — either way, it must not be accepted.
          expect(result.ok).toBe(false);
          expect(result).toHaveProperty("error");
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Every valid action string is accepted by parseArgs + validateArgs when
   * all required params are provided.
   */
  it("accepts every valid action when required params are supplied", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_ACTIONS),
        (action) => {
          // Build argv with all possible params so no required-param errors
          const argv = [
            "node", "agentbridge-browser",
            "--action", action,
            "--url", "https://example.com",
            "--selector", "#test",
            "--value", "hello",
            "--session-id", "s1",
          ];
          const raw = parseArgs(argv);
          const result = validateArgs(raw);

          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.action.action).toBe(action);
            expect(result.action.sessionId).toBe("s1");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Missing --action is always rejected.
   */
  it("rejects when --action is missing entirely", () => {
    const raw = parseArgs(["node", "agentbridge-browser"]);
    const result = validateArgs(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("--action is required");
    }
  });

  /**
   * Default session-id is "default" when not specified.
   */
  it("defaults session-id to 'default'", () => {
    const raw = parseArgs(["node", "agentbridge-browser", "--action", "screenshot"]);
    const result = validateArgs(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.sessionId).toBe("default");
    }
  });

  /**
   * --full-page flag is parsed correctly.
   */
  it("parses --full-page flag", () => {
    const raw = parseArgs([
      "node", "agentbridge-browser",
      "--action", "screenshot",
      "--full-page",
    ]);
    const result = validateArgs(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.fullPage).toBe(true);
    }
  });
});
