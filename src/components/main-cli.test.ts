import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

// #1315: TUI flag/env parsing
describe("parsePlatformFlags — TUI (#1315)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv["TELEGRAM_ENABLED"] = process.env["TELEGRAM_ENABLED"];
    savedEnv["DISCORD_ENABLED"] = process.env["DISCORD_ENABLED"];
    savedEnv["IRC_ENABLED"] = process.env["IRC_ENABLED"];
    savedEnv["TUI_ENABLED"] = process.env["TUI_ENABLED"];
    // Disable every other platform so the env path doesn't pick them up.
    delete process.env["TELEGRAM_ENABLED"];
    delete process.env["TELEGRAM_BOT_TOKEN"];
    delete process.env["DISCORD_ENABLED"];
    delete process.env["DISCORD_TOKEN"];
    delete process.env["IRC_ENABLED"];
    delete process.env["TUI_ENABLED"];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("--tui CLI flag enables TUI regardless of env", () => {
    const result = parsePlatformFlags(["--tui"]);
    expect(result.tui).toBe(true);
  });

  it("TUI_ENABLED=true enables TUI when no CLI override is present", () => {
    process.env["TUI_ENABLED"] = "true";
    const result = parsePlatformFlags([]);
    expect(result.tui).toBe(true);
  });

  it("TUI is on by default (no env, no CLI flag)", () => {
    const result = parsePlatformFlags([]);
    expect(result.tui).toBe(true);
  });

  it("any platform CLI flag forces the explicit-CLI branch (TUI off unless --tui)", () => {
    const result = parsePlatformFlags(["--telegram"]);
    expect(result.telegram).toBe(true);
    expect(result.tui).toBe(false);
  });
});
