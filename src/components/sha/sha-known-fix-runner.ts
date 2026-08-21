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
export const SHA_ALLOWED_EXECUTABLES: readonly string[] = ["abtars-edit", "abtars-cli", "git", "kill", "pkill", "rm", "systemctl"];

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

export type ExecFn = (cmd: string, args: readonly string[], opts: { timeoutMs: number }) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}>;

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: opts.timeoutMs, maxBuffer: 1_048_576 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? null : 0;
      const timedOut = Boolean(err && (err as { killed?: boolean }).killed) || Boolean(err && (err as { code?: unknown }).code === null && (err as { signal?: unknown }).signal);
      resolve({ stdout: String(stdout), stderr: String(stderr), code, timedOut });
    });
  });

export class ShaKnownFixRunner {
  private readonly exec: ExecFn;

  constructor(exec: ExecFn = defaultExec) {
    this.exec = exec;
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
  async runCommand(argv: readonly string[], timeoutMs: number): Promise<FixCommandResult> {
    const allowed = SHA_ALLOWED_EXECUTABLES.includes(basename(argv[0] ?? ""));
    if (!allowed) {
      return { ok: false, timedOut: false, exitCode: null, output: `executable "${argv[0]}" is not allowlisted for SHA known fixes` };
    }
    const result = await this.exec(argv[0]!, argv.slice(1), { timeoutMs });
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
    const action = await this.runCommand(rule.command!, ACTION_TIMEOUT_MS);
    if (!action.ok) {
      return { state: "known_fix_failed", action, verifier: null };
    }
    const verifier = await this.runCommand(rule.verifyCommand!, VERIFIER_TIMEOUT_MS);
    return {
      state: verifier.ok ? "known_fix_verified" : "known_fix_unverified",
      action,
      verifier,
    };
  }
}