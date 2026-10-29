/**
 * sha-known-fix-runner.ts — argv-only bounded known-fix action and verifier
 * lifecycle (#1688 R8). Executes only full-mode rules with `verified=true`, a
 * non-empty argv `command`, and a non-empty argv `verifyCommand`. No shell,
 * bounded output, explicit deadlines (5 min action, 2 min verifier), and an
 * allowlisted executable policy. Action exit zero is `executed`, never
 * `fixed` — only verifier exit zero records `known_fix_verified`.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { FixRule } from "./sha-policy.js";

const ACTION_TIMEOUT_MS = 5 * 60_000;
const VERIFIER_TIMEOUT_MS = 2 * 60_000;
const MAX_OUTPUT_CHARS = 4000;

/** #1688 R8: conservative executable allowlist for known-fix commands. */
export const SHA_ALLOWED_EXECUTABLES: readonly string[] = ["abtars-edit", "abtars-cli", "git"];

/**
 * Narrow workspace port so this runner stays independent of Pi/config
 * implementation details. The coordinator supplies the real
 * ShaWorkspaceManager in production; unit tests may supply a fake executor
 * without a workspace.
 */
export interface KnownFixWorkspaceGuard {
  preflight(): Promise<
    | { ok: true; canonicalPath: string }
    | { ok: false; error: string }
  >;
  validateExecutionPath?(canonicalPath: string): Promise<{ ok: true } | { ok: false; error: string }>;
  validateCommand?(argv: readonly string[], canonicalPath: string): { ok: true } | { ok: false; error: string };
}

export interface FixCommandResult {
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  output: string;
}

export interface KnownFixOutcome {
  state: "known_fix_verified" | "known_fix_unverified" | "known_fix_failed";
  action: FixCommandResult;
  verifier: FixCommandResult | null;
}

export type ExecFn = (cmd: string, args: readonly string[], opts: {
  timeoutMs: number;
  cwd?: string;
  /** Explicitly filtered; known fixes never inherit the bridge environment. */
  env?: NodeJS.ProcessEnv;
}) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}>;

const SAFE_ENV_KEYS = ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"] as const;

function safeChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutMs,
      maxBuffer: 1_048_576,
    }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? null : 0;
      const timedOut = Boolean(err && (err as { killed?: boolean }).killed) || Boolean(err && (err as { code?: unknown }).code === null && (err as { signal?: unknown }).signal);
      resolve({ stdout: String(stdout), stderr: String(stderr), code, timedOut });
    });
  });

export class ShaKnownFixRunner {
  private readonly exec: ExecFn;
  private readonly workspaceGuard?: KnownFixWorkspaceGuard;

  constructor(exec: ExecFn = defaultExec, workspaceGuard?: KnownFixWorkspaceGuard) {
    this.exec = exec;
    this.workspaceGuard = workspaceGuard;
  }

  /**
   * #1688 R8: eligibility gate. `run` rules require verified=true, command,
   * and verifier before automatic execution in full mode. Core rules without
   * a verifier are recommendation-only until explicitly completed.
   */
  static executableRule(rule: FixRule): boolean {
    return rule.action !== "suppress"
      && rule.verified === true
      && Array.isArray(rule.command) && rule.command.length > 0
      && Array.isArray(rule.verifyCommand) && rule.verifyCommand.length > 0;
  }

  /** Bounded argv-only execution of one command. */
  async runCommand(argv: readonly string[], timeoutMs: number, cwd?: string): Promise<FixCommandResult> {
    if (!argv[0]) {
      return { ok: false, timedOut: false, exitCode: null, output: "known-fix command is empty" };
    }
    const allowed = SHA_ALLOWED_EXECUTABLES.includes(basename(argv[0] ?? ""));
    if (!allowed) {
      return { ok: false, timedOut: false, exitCode: null, output: `executable "${argv[0]}" is not allowlisted for SHA known fixes` };
    }
    if (cwd && this.workspaceGuard?.validateCommand) {
      const commandCheck = this.workspaceGuard.validateCommand(argv, cwd);
      if (!commandCheck.ok) {
        return { ok: false, timedOut: false, exitCode: null, output: `known-fix command refused: ${commandCheck.error}` };
      }
    }
    const result = await this.exec(argv[0], argv.slice(1), { timeoutMs, cwd, env: safeChildEnv() });
    return {
      ok: result.code === 0 && !result.timedOut,
      timedOut: result.timedOut,
      exitCode: result.code,
      output: (result.stdout + result.stderr).slice(0, MAX_OUTPUT_CHARS),
    };
  }

  /**
   * #1688 R8: action then verifier. Action exit zero is `executed`, not
   * `fixed`. Only verifier exit zero records `known_fix_verified`.
   */
  async execute(rule: FixRule): Promise<KnownFixOutcome> {
    if (!ShaKnownFixRunner.executableRule(rule)) {
      return {
        state: "known_fix_failed",
        action: { ok: false, timedOut: false, exitCode: null, output: "rule not eligible (requires verified=true, command, verifyCommand)" },
        verifier: null,
      };
    }
    let cwd: string | undefined;
    if (this.workspaceGuard) {
      const preflight = await this.workspaceGuard.preflight();
      if (!preflight.ok) {
        return {
          state: "known_fix_failed",
          action: { ok: false, timedOut: false, exitCode: null, output: `known-fix workspace preflight failed: ${preflight.error}` },
          verifier: null,
        };
      }
      cwd = preflight.canonicalPath;
      if (this.workspaceGuard.validateExecutionPath) {
        const pathCheck = await this.workspaceGuard.validateExecutionPath(cwd);
        if (!pathCheck.ok) {
          return {
            state: "known_fix_failed",
            action: { ok: false, timedOut: false, exitCode: null, output: `known-fix workspace refused: ${pathCheck.error}` },
            verifier: null,
          };
        }
      }
    }
    const action = await this.runCommand(rule.command!, ACTION_TIMEOUT_MS, cwd);
    if (!action.ok) {
      return { state: "known_fix_failed", action, verifier: null };
    }
    // Re-check the path before the verifier as well: the action may have
    // changed or replaced the checkout, and the verifier must never follow a
    // path that escaped the original preflight.
    if (cwd && this.workspaceGuard?.validateExecutionPath) {
      const pathCheck = await this.workspaceGuard.validateExecutionPath(cwd);
      if (!pathCheck.ok) {
        return {
          state: "known_fix_unverified",
          action,
          verifier: { ok: false, timedOut: false, exitCode: null, output: `known-fix workspace refused: ${pathCheck.error}` },
        };
      }
    }
    const verifier = await this.runCommand(rule.verifyCommand!, VERIFIER_TIMEOUT_MS, cwd);
    return {
      state: verifier.ok ? "known_fix_verified" : "known_fix_unverified",
      action,
      verifier,
    };
  }
}
