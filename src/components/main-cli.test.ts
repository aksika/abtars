import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parsePlatformFlags } from "./cli-flags.js";

// Feature: kiro-professor-webui, Property 1: CLI flag parsing determines web enablement
describe("parsePlatformFlags — Property 1: CLI flag parsing determines web enablement", () => {
  it("web is true iff arguments contain --web, false otherwise", () => {
    const flagArb = fc.array(
      fc.constantFrom("--web", "--telegram", "--discord", "--memory", "--heartbeat"),
    );

    fc.assert(
      fc.property(flagArb, (args) => {
        const result = parsePlatformFlags(args);
        const shouldBeWeb = args.includes("--web");
        expect(result.web).toBe(shouldBeWeb);
      }),
      { numRuns: 100 },
    );
  });
});
