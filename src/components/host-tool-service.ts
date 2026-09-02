/**
 * host-tool-service.ts — the single shared bash execution service for PiCore
 * and ACP (#1660). Extracted from the Pi tool registry so every adapter
 * presents the same policy/execution/redaction boundary.
 *
 * Bash input may declare a small bound of `secret_env` entries whose keys use
 * the reserved `ABTARS_SECRET_` prefix. Values must be unguessable sealed
 * handles. The fixed order is:
 *
 *   1. validate schema and syntax; interactive/scheduled command-policy
 *      checks also run guardrails, bridge-spawn/kill blocks and ActionGate
 *      against the command and variable names only;
 *   2. after any applicable policy decision (none for sleep), resolve every
 *      handle through local abmind with owner/revision recheck; if any fails,
 *      spawn nothing;
 *   3. add exact values only to a fresh child env and exec;
 *   4. exact-literal redact stdout, stderr, thrown errors and result JSON
 *      before any audit/log/diagnostic/model consumer;
 *   5. release local value references and return the scrubbed result.
 */

import { execFileSync } from "node:child_process";
import { logWarn } from "./logger.js";
import { redactSecrets } from "./logger.js";
import { checkCommand, classifyCommand } from "./guardrails.js";
import { fingerprintCommand, previewCommand } from "./transport/tool-failure-diagnostic.js";
import { runBashCommand } from "./bash-runner.js";
import { getEnv } from "./env-schema.js";
import type { ToolExecutionScope } from "./tasks/task-package.js";
import type { ToolAuthorizationMode } from "./action-gate.js";
import type { ActionGate } from "./action-gate.js";
import type { SealedSecretHandles, HandleBinding } from "./sealed-secret-handles.js";

export const SECRET_ENV_PREFIX = "ABTARS_SECRET_";
const SECRET_ENV_MAX_ENTRIES = 16;
const SECRET_ENV_MAX_BYTES = 64 * 1024;
const SECRET_ENV_KEY_RE = /^ABTARS_SECRET_[A-Z0-9_]+$/;
const REDACTED_LITERAL = "[REDACTED]";

export interface HostBashInput {
  readonly command: string;
  readonly secretEnv?: Readonly<Record<string, string>>;
}

export interface HostExecutionContext {
  readonly userId: string;
  readonly executionId: string;
  readonly signal?: AbortSignal;
  readonly executionScope?: ToolExecutionScope;
  readonly authorizationMode?: ToolAuthorizationMode;
}

/** Resolve one handle to its exact plaintext for the same owner/execution. */
export type HandleResolver = (binding: HandleBinding) => Promise<{
  memoryId: number;
  semanticRevision: number;
  value: string;
} | null>;

export interface HostToolServiceDeps {
  handles: SealedSecretHandles;
  actionGate: ActionGate | null;
  resolveHandle: HandleResolver;
}

// ── Exact-literal redaction ─────────────────────────────────────────────────

/**
 * Scrub exact secret literals from any text before it crosses to the model or
 * a persistent sink. Overlapping literals are replaced longest-first so a
 * short literal can never survive inside a longer one. Only literal bytes are
 * scrubbed; regex pattern matching is deliberately NOT used (the acceptance
 * fixture defeats static regexes).
 */
export function redactLiterals(text: string, literals: readonly string[]): string {
  if (literals.length === 0) return text;
  const ordered = [...literals]
    .filter((l) => l.length > 0)
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const literal of ordered) {
    result = result.split(literal).join(REDACTED_LITERAL);
  }
  return result;
}

// ── Syntax + policy helpers (extracted from tool-registry) ──────────────────

function validateBashSyntax(cmd: string): { ok: true } | { ok: false; stderr: string; hint?: string } {
  try {
    execFileSync("bash", ["--noprofile", "--norc", "-n", "-c", cmd], { timeout: 5000, maxBuffer: 64 * 1024, stdio: "pipe" });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string; code?: string | number; killed?: boolean; signal?: string };
    const msg = e.message ?? "";
    if (e.code === "ENOENT" || e.code === "ETIMEDOUT" || e.code === "ENOBUFS" || e.killed === true || e.signal || /maxBuffer|timed out/i.test(msg)) return { ok: true };
    const raw = typeof e.stderr === "string" ? e.stderr : e.stderr instanceof Buffer ? e.stderr.toString("utf-8") : "";
    const stderr = redactSecrets(raw || msg || "syntax error").slice(0, 1000);
    const trimmed = cmd.trimEnd();
    let hint: string | undefined;
    if (/\b2>&\s*$/.test(trimmed)) {
      hint = 'redirection operator truncated — did you mean "2>&1"? Re-submit the corrected command explicitly.';
    }
    return { ok: false, stderr, hint };
  }
}

const BLOCKED_PATTERNS: readonly RegExp[] = [
  /\bmain\.js\b/,
  /\babtars\.sh\b/,
  /\bwatchdog\.sh\b/,
  /\blaunchctl\s+(load|bootstrap|kickstart|start)\b/,
];

function isBridgeSpawnCommand(cmd: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(cmd));
}

function isBridgeKillCommand(cmd: string): boolean {
  const pid = process.pid;
  const ppid = process.ppid;
  if (new RegExp(`\\bkill\\s+(-\\d+\\s+)?${pid}\\b`).test(cmd)) return true;
  if (new RegExp(`\\bkill\\s+(-\\d+\\s+)?${ppid}\\b`).test(cmd)) return true;
  if (/\b(pkill|killall)\b.*\b(abtars|main\.js|watchdog)\b/.test(cmd)) return true;
  if (/\bkill\b.*\$\(.*pgrep.*abtars/.test(cmd)) return true;
  return false;
}

// ── Service ─────────────────────────────────────────────────────────────────

export class HostToolService {
  constructor(private readonly deps: HostToolServiceDeps) {}

  /**
   * Validate the input contract. Returns a refusal message or null. The
   * command is checked against ambient/execution env collisions; values are
   * handles at this stage, so nothing sensitive enters any policy surface.
   */
  validateInput(input: HostBashInput, ctx: HostExecutionContext): string | null {
    if (typeof input.command !== "string" || input.command.trim() === "") {
      return "execute_bash requires a non-empty command string";
    }
    if (input.secretEnv !== undefined) {
      if (input.secretEnv === null || typeof input.secretEnv !== "object" || Array.isArray(input.secretEnv)) {
        return "secret_env must be an object of variable names to sealed handles";
      }
      const entries = Object.entries(input.secretEnv);
      if (entries.length === 0) return "secret_env must declare at least one variable";
      if (entries.length > SECRET_ENV_MAX_ENTRIES) {
        return `secret_env is limited to ${SECRET_ENV_MAX_ENTRIES} variables`;
      }
      const serializedBytes = Buffer.byteLength(JSON.stringify(input.secretEnv), "utf-8");
      if (serializedBytes > SECRET_ENV_MAX_BYTES) {
        return "secret_env exceeds its serialized size bound";
      }
      const ambient = { ...process.env, ...(ctx.executionScope?.env ?? {}) };
      for (const [name, handle] of entries) {
        if (!SECRET_ENV_KEY_RE.test(name)) {
          return `secret_env variable ${name} must match ${SECRET_ENV_KEY_RE}`;
        }
        if (name in ambient) {
          return `secret_env variable ${name} collides with an ambient environment variable`;
        }
        if (typeof handle !== "string" || !handle.startsWith("secret:")) {
          return `secret_env variable ${name} must be a sealed handle`;
        }
      }
      for (const name of entries.map(([n]) => n)) {
        if (!input.command.includes(name)) {
          return `secret_env variable ${name} is not referenced by the command`;
        }
      }
    }
    return null;
  }

  async runBash(input: HostBashInput, ctx: HostExecutionContext): Promise<string> {
    const contractError = this.validateInput(input, ctx);
    if (contractError) {
      return JSON.stringify({ error: "policy_rejected", stderr: contractError, exit_code: 126, command_fingerprint: fingerprintCommand(input.command), command_preview: previewCommand(input.command) });
    }

    const cmd = input.command;

    // Syntax validation (parse-only).
    const syntaxCheck = validateBashSyntax(cmd);
    if (!syntaxCheck.ok) {
      const result: Record<string, unknown> = {
        error: "shell_syntax_error",
        stderr: syntaxCheck.stderr,
        exit_code: 2,
        command_fingerprint: fingerprintCommand(cmd),
        command_preview: previewCommand(cmd),
      };
      if (syntaxCheck.hint) result["syntax_hint"] = syntaxCheck.hint;
      return JSON.stringify(result);
    }

    // Normal sleep is explicitly an unrestricted unattended execution origin:
    // command guardrails, bridge self-protection, and ActionGate must not turn
    // a model-produced Bash operation into a Telegram-dependent failure.
    // Contract validation, syntax reporting, timeouts, cancellation, sealed
    // handle binding, and output redaction remain execution-boundary duties.
    if (ctx.authorizationMode !== "unattended-sleep") {
      // Guardrails — one deterministic policy result for classifier,
      // guardrail, auth, and audit.
      const tier = classifyCommand(cmd);
      if (tier === "block") {
        const blockMsg = checkCommand(cmd);
        if (blockMsg) {
          logWarn("host-tool-service", `Guardrails blocked [${fingerprintCommand(cmd)}]: ${previewCommand(cmd)}`);
          return policyRejected(cmd, blockMsg);
        }
      }

      // Bridge self-protection — checked before auth, same result for audit.
      if (isBridgeSpawnCommand(cmd)) {
        return policyRejected(cmd, "Command blocked: this would spawn/restart a bridge or watchdog process. The bridge is already running under launchd+watchdog supervision.");
      }
      if (isBridgeKillCommand(cmd)) {
        return policyRejected(cmd, "Command blocked: this would kill the bridge process (yourself). Ask the user to send /restart for a session reset.");
      }

      // ActionGate: only command + variable names reach the authorization
      // surface — never handle values (and never plaintext at this point).
      if (tier === "auth-required" && this.deps.actionGate) {
        const granted = await this.deps.actionGate.requestAuth("bash-auth", cmd, { mode: ctx.authorizationMode });
        if (!granted) {
          logWarn("host-tool-service", `Auth denied [${fingerprintCommand(cmd)}]: ${previewCommand(cmd)}`);
          return policyRejected(cmd, "Command requires authorization. Master denied or timed out.");
        }
      }
    }

    // Resolve every handle after approval; spawn nothing on any failure.
    const resolvedEnv: Array<{ name: string; value: string }> = [];
    try {
      if (input.secretEnv) {
        for (const [name, handle] of Object.entries(input.secretEnv)) {
          const binding = this.deps.handles.lookup(handle, { executionId: ctx.executionId, userId: ctx.userId });
          const resolved = binding ? await this.deps.resolveHandle(binding) : null;
          if (!resolved) {
            return JSON.stringify({ error: "sealed_handle_invalid", stderr: "One or more sealed handles could not be resolved for this execution.", exit_code: 126, command_fingerprint: fingerprintCommand(cmd), command_preview: previewCommand(cmd) });
          }
          resolvedEnv.push({ name, value: resolved.value });
        }
      }

      const literals = resolvedEnv.map((entry) => entry.value);
      const result = await this.spawnBash(cmd, ctx, resolvedEnv, literals);
      // spawnBash scrubs its text fields; this second pass covers every JSON
      // field (including previews and future result fields) before return.
      return redactLiterals(result, literals);
    } catch {
      // A resolver or child-process exception must not cross the boundary:
      // third-party error messages may contain a credential. Keep the failure
      // deliberately generic and expose only a non-sensitive command digest.
      return JSON.stringify({
        error: "execution_failed",
        stderr: "Sealed command execution failed.",
        exit_code: null,
        command_fingerprint: fingerprintCommand(cmd),
      });
    } finally {
      // Release local value references, including values retained in the
      // mutable entries until the finally block runs.
      for (const entry of resolvedEnv) entry.value = "";
      resolvedEnv.length = 0;
    }
  }

  private spawnBash(
    cmd: string,
    ctx: HostExecutionContext,
    secretEnv: Array<{ name: string; value: string }>,
    literals: string[],
  ): Promise<string> {
    const childEnv: NodeJS.ProcessEnv = ctx.executionScope
      ? { ...process.env, ...ctx.executionScope.env }
      : { ...process.env };
    for (const entry of secretEnv) {
      childEnv[entry.name] = entry.value;
    }

    return runBashCommand({
      cmd,
      bin: "bash",
      args: ["-c", cmd],
      cwd: ctx.executionScope?.cwd,
      env: childEnv,
      signal: ctx.signal,
      timeoutMs: getEnv().bashToolTimeoutSec * 1000,
    }).then((result) => {
      const record: Record<string, unknown> = { ...result };
      if (typeof record["stdout"] === "string") {
        record["stdout"] = redactLiterals(record["stdout"], literals);
      }
      if (typeof record["stderr"] === "string") {
        record["stderr"] = redactLiterals(record["stderr"], literals);
      }
      return JSON.stringify(record);
    });
  }
}

function policyRejected(cmd: string, stderr: string): string {
  logWarn("host-tool-service", `Blocked [${fingerprintCommand(cmd)}]: ${previewCommand(cmd)}`);
  return JSON.stringify({
    error: "policy_rejected",
    stderr,
    exit_code: 126,
    command_fingerprint: fingerprintCommand(cmd),
    command_preview: previewCommand(cmd),
  });
}
