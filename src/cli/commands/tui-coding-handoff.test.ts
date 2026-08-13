/**
 * tui-coding-handoff.test.ts — #1635 Phase 2 client-side handoff decisions.
 *
 * Pure coverage of the local-only boundary: command interception, local
 * pi-executor.json reading, structured argument construction (the bridge
 * never supplies an executable or argument vector), and the no-abmind child
 * environment.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isNativeHandoffCommand,
  readClientPiConfig,
  trustFor,
  buildNativeHandoffArgs,
  buildNativeHandoffEnv,
} from "./tui-coding-handoff.js";
import type { NativeCodingHandoffInfo } from "../../platforms/tui/tui-protocol.js";

const RESUME_HANDOFF: NativeCodingHandoffInfo = {
  sessionId: "spin-c-1",
  workspaceAlias: "repo-a",
  canonicalPath: "/ws/repo-a",
  memoryMode: "none",
  sessionStorageRoot: "/state/pi",
  piSessionId: "sess-1",
  piSessionFile: "/state/pi/--ws--/2026-08-13T00-00-00-000Z_sess-1.jsonl",
};

const INITIAL_HANDOFF: NativeCodingHandoffInfo = {
  sessionId: "spin-c-2",
  workspaceAlias: "repo-b",
  canonicalPath: "/ws/repo-b",
  memoryMode: "none",
  sessionStorageRoot: "/state/pi",
  newPiSessionId: "019f0000-0000-7000-8000-000000000000",
  modelProvider: "openrouter",
  modelId: "deepseek/deepseek-v4-flash",
  thinking: "medium",
};

describe("isNativeHandoffCommand", () => {
  it("intercepts plain /coding and new/resume subcommands", () => {
    expect(isNativeHandoffCommand("/coding")).toBe(true);
    expect(isNativeHandoffCommand("  /coding  ")).toBe(true);
    expect(isNativeHandoffCommand("/coding new repo-a")).toBe(true);
    expect(isNativeHandoffCommand("/coding new repo-a extra")).toBe(true);
    expect(isNativeHandoffCommand("/coding resume")).toBe(true);
    expect(isNativeHandoffCommand("/coding resume spin-c-1")).toBe(true);
    expect(isNativeHandoffCommand("/CODING NEW REPO-A")).toBe(true);
  });

  it("passes management and unrelated commands through to the bridge", () => {
    expect(isNativeHandoffCommand("/coding status")).toBe(false);
    expect(isNativeHandoffCommand("/coding off")).toBe(false);
    expect(isNativeHandoffCommand("/coding end")).toBe(false);
    expect(isNativeHandoffCommand("/coding end spin-c-1")).toBe(false);
    expect(isNativeHandoffCommand("/coding whatever")).toBe(false);
    expect(isNativeHandoffCommand("//coding new x")).toBe(false);
    expect(isNativeHandoffCommand("/pi run")).toBe(false);
    expect(isNativeHandoffCommand("help me refactor")).toBe(false);
  });
});

describe("readClientPiConfig", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-config-test-"));
    mkdirSync(join(home, "config"), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reads fixedArgs, top-level trust, and per-alias trust", () => {
    writeFileSync(join(home, "config", "pi-executor.json"), JSON.stringify({
      enabled: true,
      command: "/bin/pi",
      fixedArgs: ["--extension", "plan"],
      projectTrust: "always",
      workspaceAliases: { "repo-a": { path: "/ws/repo-a" }, "repo-b": { path: "/ws/repo-b", projectTrust: "never" } },
    }), "utf-8");
    const config = readClientPiConfig(home)!;
    expect(config.fixedArgs).toEqual(["--extension", "plan"]);
    expect(trustFor(config, "repo-a")).toBe("always");
    expect(trustFor(config, "repo-b")).toBe("never");
    expect(trustFor(config, "unknown")).toBe("always");
  });

  it("defaults to never when trust is absent", () => {
    writeFileSync(join(home, "config", "pi-executor.json"), JSON.stringify({
      enabled: true, command: "/bin/pi", workspaceAliases: { "repo-a": { path: "/ws/repo-a" } },
    }), "utf-8");
    const config = readClientPiConfig(home)!;
    expect(config.projectTrust).toBe("never");
    expect(trustFor(config, "repo-a")).toBe("never");
  });

  it("fails closed on missing or malformed config", () => {
    expect(readClientPiConfig(home)).toBeNull();
    writeFileSync(join(home, "config", "pi-executor.json"), "{not json", "utf-8");
    expect(readClientPiConfig(home)).toBeNull();
    writeFileSync(join(home, "config", "pi-executor.json"), JSON.stringify({ command: 5 }), "utf-8");
    expect(readClientPiConfig(home)).not.toBeNull();
  });
});

describe("buildNativeHandoffArgs", () => {
  const config = {
    fixedArgs: ["--extension", "plan"],
    projectTrust: "never" as const,
    aliases: { "repo-a": { projectTrust: "always" as const } },
  };

  it("resume: proven file via --session with the storage root and per-alias trust", () => {
    const args = buildNativeHandoffArgs(RESUME_HANDOFF, config);
    expect(args).toEqual([
      "--extension", "plan",
      "--approve",
      "--session-dir", "/state/pi",
      "--session", RESUME_HANDOFF.piSessionFile,
    ]);
    // fixedArgs never override the handoff-owned flags (they come first)
    expect(args.indexOf("--session")).toBeGreaterThan(args.indexOf("--approve"));
  });

  it("initial: --session-id identity with no file", () => {
    const args = buildNativeHandoffArgs(INITIAL_HANDOFF, { ...config, aliases: { "repo-b": {} } });
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe(INITIAL_HANDOFF.newPiSessionId);
    expect(args).not.toContain("--session");
  });

  it("contains no executable — the caller resolves it locally", () => {
    const args = buildNativeHandoffArgs(RESUME_HANDOFF, config);
    // the arg vector starts with a flag; the executable is passed separately
    expect(args[0]?.startsWith("--")).toBe(true);
    expect(args.some((a) => a === "pi" || a.startsWith("node"))).toBe(false);
  });

  it("maps saved model facts to Pi flags", () => {
    const args = buildNativeHandoffArgs(INITIAL_HANDOFF, { ...config, aliases: { "repo-b": {} } });
    expect(args).toEqual(expect.arrayContaining([
      "--provider", "openrouter",
      "--model", "deepseek/deepseek-v4-flash",
      "--thinking", "medium",
    ]));
  });
});

describe("buildNativeHandoffEnv", () => {
  it("omits the abmind correlation vars and disables hooks", () => {
    const env = buildNativeHandoffEnv({
      HOME: "/home/u",
      ABMIND_USER_ID: "u-1",
      ABMIND_PARENT_EXECUTION_ID: "pi-run-x",
      ABMIND_AUTOMATIC_WRITE_OWNER: "abmind-pi-plugin",
      PATH: "/usr/bin",
    });
    expect(env["HOME"]).toBe("/home/u");
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["ABMIND_USER_ID"]).toBeUndefined();
    expect(env["ABMIND_PARENT_EXECUTION_ID"]).toBeUndefined();
    expect(env["ABMIND_AUTOMATIC_WRITE_OWNER"]).toBeUndefined();
    expect(env["ABMIND_HOOKS_DISABLED"]).toBe("true");
  });

  it("inherits the client env (native mode is the user's interactive session)", () => {
    const env = buildNativeHandoffEnv({ NVM_DIR: "/nvm", MY_KEY: "secret", UNDEFINED_VAR: undefined });
    expect(env["NVM_DIR"]).toBe("/nvm");
    expect(env["MY_KEY"]).toBe("secret");
    expect(env["UNDEFINED_VAR"]).toBeUndefined();
  });
});
