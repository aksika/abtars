/**
 * tui-coding-handoff.ts — #1635 Phase 2 native TUI handoff (client side).
 *
 * The `abtars tui` client owns the native handoff: after the bridge accepts
 * (lease + workspace claim + shared Pi slot held), the client resolves the
 * pinned Pi executable LOCALLY, builds its own argument vector from the
 * bridge-supplied session FACTS (never an executable or argument vector —
 * local-host-only rule) plus the local pi-executor.json, suspends the abTARS
 * render shell, and spawns Pi interactively in the approved workspace with
 * the proven session file.
 *
 * This module is deliberately small and dependency-free (fs/path/spawn only)
 * so the orchestration in `tui.ts` stays thin and every pure decision here
 * is directly testable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { NativeCodingHandoffInfo } from "../../platforms/tui/tui-protocol.js";

/** #1635 Phase 2 — local pi-executor.json projection for the handoff args. */
export interface ClientPiConfig {
  fixedArgs: readonly string[];
  projectTrust: "always" | "never";
  aliases: Record<string, { projectTrust?: string }>;
}

/** #1635 Phase 2 — the client builds the child environment itself: the three
 *  abmind correlation variables are omitted and the hooks disabled, keeping
 *  the no-abmind contract for the native process as well. */
const ABMIND_OMITTED_VARS = [
  "ABMIND_USER_ID",
  "ABMIND_PARENT_EXECUTION_ID",
  "ABMIND_AUTOMATIC_WRITE_OWNER",
] as const;

/**
 * Pure predicate: does this editor line request a NATIVE handoff? Only
 * `/coding`, `/coding new <alias>`, and `/coding resume [id]` — management
 * subcommands (`status`, `off`, `end`) keep routing through the bridge's
 * command registry.
 */
export function isNativeHandoffCommand(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === "/coding") return true;
  return /^\/coding\s+(new|resume)(\s|$)/i.test(trimmed);
}

/**
 * Read the local pi-executor.json for the handoff's fixed args and trust
 * policy. The bridge never supplies these (they are an argument vector); the
 * client reads the same file the bridge validates at boot. Missing or
 * malformed config fails closed — no args are guessed.
 */
export function readClientPiConfig(homeDir: string): ClientPiConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(homeDir, "config", "pi-executor.json"), "utf-8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as {
    fixedArgs?: unknown;
    projectTrust?: unknown;
    workspaceAliases?: unknown;
  };
  const fixedArgs = Array.isArray(obj.fixedArgs)
    ? obj.fixedArgs.filter((a): a is string => typeof a === "string")
    : [];
  const projectTrust = obj.projectTrust === "always" ? "always" : "never";
  let aliases: Record<string, { projectTrust?: string }> = {};
  if (typeof obj.workspaceAliases === "object" && obj.workspaceAliases !== null) {
    for (const [alias, value] of Object.entries(obj.workspaceAliases as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null) {
        const trust = (value as { projectTrust?: unknown }).projectTrust;
        aliases[alias] = { projectTrust: trust === "always" ? "always" : trust === "never" ? "never" : undefined };
      }
    }
  }
  return { fixedArgs, projectTrust, aliases };
}

/** Per-alias trust: alias override, else the top-level policy, else "never". */
export function trustFor(config: ClientPiConfig, alias: string): "always" | "never" {
  const aliasTrust = config.aliases[alias]?.projectTrust;
  if (aliasTrust === "always" || aliasTrust === "never") return aliasTrust;
  return config.projectTrust;
}

/**
 * Build the Pi interactive argument vector from session facts + local config.
 * fixedArgs come first so the handoff-owned flags below always win. The
 * executable is deliberately NOT an argument — the caller passes it to spawn.
 */
export function buildNativeHandoffArgs(handoff: NativeCodingHandoffInfo, config: ClientPiConfig): string[] {
  const args = [...config.fixedArgs];
  args.push(trustFor(config, handoff.workspaceAlias) === "always" ? "--approve" : "--no-approve");
  args.push("--session-dir", handoff.sessionStorageRoot);
  if (handoff.piSessionFile) {
    args.push("--session", handoff.piSessionFile);
  } else if (handoff.newPiSessionId) {
    args.push("--session-id", handoff.newPiSessionId);
  }
  if (handoff.modelProvider) args.push("--provider", handoff.modelProvider);
  if (handoff.modelId) args.push("--model", handoff.modelId);
  if (handoff.thinking) args.push("--thinking", handoff.thinking);
  return args;
}

/**
 * Build the native child env: the client's own env minus the abmind
 * correlation variables, with the hooks disabled. The native process is the
 * user's interactive Pi session, so its env is the client's env — unlike the
 * deny-by-default RPC child env, which carries injected correlation.
 */
export function buildNativeHandoffEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (ABMIND_OMITTED_VARS.includes(key as (typeof ABMIND_OMITTED_VARS)[number])) continue;
    if (value === undefined) continue;
    env[key] = value;
  }
  env["ABMIND_HOOKS_DISABLED"] = "true";
  return env;
}

/** Spawn the pinned Pi executable interactively; Pi owns the terminal. */
export function spawnNativeHandoff(
  executable: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): ChildProcess {
  return spawn(executable, args, { cwd, env, stdio: "inherit", shell: false });
}

/** Resolve the spawned Pi process's exit code (null on spawn error). */
export function waitForNativeExit(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
}
