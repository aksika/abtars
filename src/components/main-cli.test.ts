import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parsePlatformFlags } from "./cli-flags.js";

// Feature: kiro-professor-webui, Property 1: CLI flag parsing determines web enablement
describe("parsePlatformFlags — Property 1: CLI flag parsing determines web enablement", () => {
  it("web is true iff arguments contain --web or --all, false otherwise", () => {
    /**
     * Validates: Requirements 1.1, 1.2
     *
     * For any set of CLI arguments, parsed result has web: true iff
     * arguments contain --web or --all. All other combinations yield
     * web: false.
     */
    const flagArb = fc.array(
      fc.constantFrom("--web", "--all", "--telegram", "--discord", "--memory", "--heartbeat"),
    );

    fc.assert(
      fc.property(flagArb, (args) => {
        const result = parsePlatformFlags(args);
        const shouldBeWeb = args.includes("--web") || args.includes("--all");
        expect(result.web).toBe(shouldBeWeb);
      }),
      { numRuns: 100 },
    );
  });
});
