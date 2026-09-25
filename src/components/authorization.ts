/**
 * authorization.ts — the single owner of SECURITY_MODE policy (#1851).
 *
 * It resolves the configured mode, applies mode semantics for the two decision
 * surfaces (bash commands and tool paths), and writes one audit row per
 * decision through one writer to the rotated sink
 * (~/.abtars/logs/audit.jsonl). guardrails.ts is only a pure command
 * classifier; ActionGate stays the approval mechanism and reports an outcome
 * the caller records here. `authorizationMode` (interactive / unattended-* /
 * unverified) is durable provenance carried into a decision, never a switch.
 */

import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { abmindHome, abtarsHome } from "../paths.js";
import { logAndSwallow } from "./log-and-swallow.js";
import { classifyCommand, isRootScopeAllow } from "./guardrails.js";
import { getEnv } from "./env-schema.js";
import type { ActionGate, ToolAuthorizationMode } from "./action-gate.js";
import type { CheckResult, SandboxPolicy } from "./tool-sandbox.js";

const TAG = "authorization";

// ── Mode resolution ─────────────────────────────────────────────────────────

/** Accepted SECURITY_MODE values. Only off and guardrails are wired. */
export type SecurityMode = "off" | "guardrails" | "seatbelt" | "docker";
export type EffectiveSecurityMode = "off" | "guardrails";

export interface ResolvedSecurityMode {
  /** The configured value, for display/provenance. */
  readonly configured: string;
  /** The mode actually applied. */
  readonly effective: EffectiveSecurityMode;
  /** True when the configured mode has no wired containment and guardrails apply. */
  readonly fallback: boolean;
}

/**
 * Resolve SECURITY_MODE to its effective behavior. `seatbelt` and `docker`
 * remain accepted for future OS-containment work (#1758) but apply guardrails
 * today; an unrecognized value also falls back to guardrails so a typo never
 * silently disables policy.
 */
export function resolveSecurityMode(): ResolvedSecurityMode {
  const raw = (getEnv().securityMode || "off").trim();
  if (raw === "off") return { configured: "off", effective: "off", fallback: false };
  if (raw === "guardrails") return { configured: "guardrails", effective: "guardrails", fallback: false };
  return { configured: raw, effective: "guardrails", fallback: true };
}

// ── One audit writer ────────────────────────────────────────────────────────

export interface AuthorizationAuditEntry {
  readonly surface: "bash" | "path";
  readonly outcome: "allow" | "block" | "approved" | "denied";
  /** Which rule applied: mode, classifier tier, root-scope, rule id, action-gate path, ... */
  readonly source: string;
  readonly detail: string;
  readonly pattern?: string;
}

const AUDIT_DETAIL_MAX = 200;

/**
 * Append one authorization decision. Every decision surface funnels here so
 * the sink has a single schema (event "authorization") alongside the existing
 * tool-call audit rows. Best-effort: a full disk must not change a verdict.
 */
export function writeAuthorizationAudit(entry: AuthorizationAuditEntry): void {
  const record: Record<string, string> = {
    ts: new Date().toISOString(),
    event: "authorization",
    surface: entry.surface,
    outcome: entry.outcome,
    source: entry.source,
    detail: entry.detail.slice(0, AUDIT_DETAIL_MAX),
  };
  if (entry.pattern !== undefined) record["pattern"] = entry.pattern.slice(0, AUDIT_DETAIL_MAX);
  const path = join(abtarsHome(), "logs", "audit.jsonl");
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n");
  } catch (err) {
    logAndSwallow(TAG, "write authorization audit", err);
  }
}

// ── Bash decision ───────────────────────────────────────────────────────────

export type BashAuthorization =
  | { readonly decision: "allow"; readonly by: "mode-off" | "classifier" | "root-scope" | "unattended-sleep" | "no-approval-surface" }
  | { readonly decision: "approved"; readonly by: "rule" | "always" | "once" | "unattended-task"; readonly pattern?: string }
  | { readonly decision: "block"; readonly by: "bridge-self-protection" | "classifier" | "approval"; readonly reason: string };

export interface BashAuthorizationContext {
  readonly cwd?: string;
  readonly actionGate: ActionGate | null;
  readonly authorizationMode?: ToolAuthorizationMode;
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

/**
 * One bash decision: bridge self-protection, mode semantics, classifier tier,
 * root-scope allow, and ActionGate approval in a fixed order. Returns the
 * verdict the caller acts on; every block/approval/root-scope decision leaves
 * exactly one audit row here.
 */
export async function authorizeBashCommand(cmd: string, context: BashAuthorizationContext): Promise<BashAuthorization> {
  // Normal sleep is an unrestricted unattended execution origin: command
  // guardrails, bridge self-protection, and ActionGate must not turn a
  // model-produced Bash operation into a Telegram-dependent failure (#1752).
  if (context.authorizationMode === "unattended-sleep") {
    return { decision: "allow", by: "unattended-sleep" };
  }

  // Bridge self-protection prevents self-destruction and is not an
  // authorization policy: it applies in every mode, including off.
  if (isBridgeSpawnCommand(cmd)) {
    writeAuthorizationAudit({ surface: "bash", outcome: "block", source: "bridge-self-protection", detail: cmd });
    return {
      decision: "block",
      by: "bridge-self-protection",
      reason: "Command blocked: this would spawn/restart a bridge or watchdog process. The bridge is already running under launchd+watchdog supervision.",
    };
  }
  if (isBridgeKillCommand(cmd)) {
    writeAuthorizationAudit({ surface: "bash", outcome: "block", source: "bridge-self-protection", detail: cmd });
    return {
      decision: "block",
      by: "bridge-self-protection",
      reason: "Command blocked: this would kill the bridge process (yourself). Ask the user to send /restart for a session reset.",
    };
  }

  const { effective } = resolveSecurityMode();
  if (effective === "off") {
    return { decision: "allow", by: "mode-off" };
  }

  const tier = classifyCommand(cmd, context.cwd);
  if (tier === "block") {
    writeAuthorizationAudit({ surface: "bash", outcome: "block", source: "guardrails", detail: cmd });
    return { decision: "block", by: "classifier", reason: `Command blocked by guardrails: ${cmd.slice(0, 60)}` };
  }
  if (tier === "allow") {
    if (isRootScopeAllow(cmd, context.cwd)) {
      writeAuthorizationAudit({ surface: "bash", outcome: "allow", source: "root-scope", detail: cmd });
      return { decision: "allow", by: "root-scope" };
    }
    return { decision: "allow", by: "classifier" };
  }

  // auth-required: ActionGate owns rules, seeds, and the Telegram prompt.
  if (!context.actionGate) {
    return { decision: "allow", by: "no-approval-surface" };
  }
  const outcome = await context.actionGate.requestAuth("bash-auth", cmd, { mode: context.authorizationMode });
  if (outcome.granted) {
    const pattern = outcome.by === "rule" || outcome.by === "always" ? outcome.pattern : undefined;
    writeAuthorizationAudit({ surface: "bash", outcome: "approved", source: outcome.by, detail: cmd, ...(pattern !== undefined ? { pattern } : {}) });
    return { decision: "approved", by: outcome.by, ...(pattern !== undefined ? { pattern } : {}) };
  }
  const pattern = outcome.by === "rule" ? outcome.pattern : undefined;
  writeAuthorizationAudit({ surface: "bash", outcome: "denied", source: outcome.by, detail: cmd, ...(pattern !== undefined ? { pattern } : {}) });
  return { decision: "block", by: "approval", reason: "Command requires authorization. Master denied or timed out." };
}

// ── Path decision ───────────────────────────────────────────────────────────

function isUnder(resolved: string, root: string): boolean {
  return resolved === root || (root === sep ? resolved.startsWith(sep) : resolved.startsWith(root + sep));
}

/**
 * Match both the lexical (symlink-unresolved) and real paths. /etc, /tmp, and
 * /var are symlinks on macOS, so a realpath-only check would miss their
 * blocklist entries; a lexical-only check would miss symlinked escapes.
 */
function matchesBlockedPath(abs: string, normalized: string, root: string): boolean {
  return isUnder(abs, root) || isUnder(normalized, root);
}

interface BlockedPath {
  readonly path: string;
  readonly writeOnly: boolean;
}

/**
 * Guardrail path blocklist, revived from the never-imported
 * guardrails.checkPath/BLOCKED_PATHS/WRITE_BLOCKED and merged with the live
 * tool-sandbox blacklist so owner (wildcard) sessions are covered too.
 * Resolved per call so ABTARS_HOME/ABMIND_HOME overrides and hermetic tests
 * work. Applies while SECURITY_MODE is effectively guardrails.
 */
function guardrailBlockedPaths(): BlockedPath[] {
  const home = homedir();
  return [
    { path: abmindHome(), writeOnly: false },
    { path: join(abtarsHome(), "config"), writeOnly: false },
    { path: join(abtarsHome(), "secret"), writeOnly: false },
    { path: resolve(home, ".abtars", "secret"), writeOnly: false },
    { path: resolve(home, ".abtars", "config", "peers.json"), writeOnly: true },
    { path: resolve(home, ".ssh"), writeOnly: false },
    { path: resolve(home, ".kiro"), writeOnly: true },
    { path: "/etc", writeOnly: false },
    { path: "/proc", writeOnly: false },
    { path: "/sys", writeOnly: false },
    { path: "/dev", writeOnly: false },
    { path: "/root", writeOnly: false },
    { path: "/run", writeOnly: false },
  ];
}

/** Session-scoped blacklist for explicit (non-wildcard) policies. */
function sessionBlockedPaths(): string[] {
  return [resolve(abtarsHome(), "config"), resolve(abtarsHome(), "secret"), resolve(abmindHome())];
}

function auditPathBlock(filePath: string, source: string): void {
  writeAuthorizationAudit({ surface: "path", outcome: "block", source, detail: filePath });
}

/**
 * One path decision for a read or write. Guardrail blocks apply to every
 * session while the mode is guardrails (wildcard policies included); session
 * policies (peer allowed lists and their blacklist) apply independently of
 * SECURITY_MODE so a peer sandbox is never silently widened by mode off.
 */
export function authorizePath(filePath: string, mode: "read" | "write", policy: SandboxPolicy): CheckResult {
  const expanded = filePath.replace(/^~/, homedir());
  const normalized = resolve(expanded);
  let abs: string;
  try { abs = realpathSync(normalized); } catch { abs = normalized; /* file may not exist yet (write) */ }

  const list = mode === "read" ? policy.allowedRead : policy.allowedWrite;

  if (resolveSecurityMode().effective === "guardrails") {
    const blocked = guardrailBlockedPaths().find((entry) => (mode === "write" || !entry.writeOnly) && matchesBlockedPath(abs, normalized, entry.path));
    if (blocked) {
      auditPathBlock(filePath, "guardrail-path");
      return { allowed: false, reason: `Path '${filePath}' is restricted by guardrails` };
    }
  }

  if (list.length === 1 && list[0] === "*") return { allowed: true };

  for (const blocked of sessionBlockedPaths()) {
    if (matchesBlockedPath(abs, normalized, blocked)) {
      auditPathBlock(filePath, "session-policy");
      return { allowed: false, reason: `Path '${filePath}' is restricted` };
    }
  }
  if (list.length === 0) {
    auditPathBlock(filePath, "session-policy");
    return { allowed: false, reason: `No ${mode} access in this session` };
  }
  for (const prefix of list) {
    const absPrefix = resolve(prefix.replace(/^~/, homedir()));
    if (isUnder(abs, absPrefix)) return { allowed: true };
  }
  auditPathBlock(filePath, "session-policy");
  return { allowed: false, reason: `Path '${filePath}' not in allowed ${mode} paths` };
}
