/**
 * tool-sandbox.ts — unified policy enforcement for tool access and path restrictions.
 * Provides SandboxPolicy interface, check functions, loop guardrails, and audit logging.
 */

import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";
import { logAndSwallow } from "./log-and-swallow.js";

export interface SandboxPolicy {
  readonly allowedTools: string[];
  readonly allowedRead: string[];
  readonly allowedWrite: string[];
  readonly canExecuteBash: boolean;
}

export interface CheckResult {
  allowed: boolean;
  reason?: string;
}

const PATH_BLACKLIST: readonly string[] = [
  resolve(abtarsHome(), "config"),
  resolve(abtarsHome(), "secret"),
  resolve(homedir(), ".abmind"),
];

const AUDIT_DIR = join(abtarsHome(), "logs");
const AUDIT_PATH = join(AUDIT_DIR, "audit.jsonl");
try { mkdirSync(AUDIT_DIR, { recursive: true }); } catch (err) { logAndSwallow("tool-sandbox", "mkdirSync", err); }

export function checkTool(name: string, policy: SandboxPolicy): CheckResult {
  if (policy.allowedTools.length === 1 && policy.allowedTools[0] === "*") return { allowed: true };
  if (policy.allowedTools.length === 0) return { allowed: false, reason: `Tool '${name}' not available in this session` };
  if (name === "execute_bash" && !policy.canExecuteBash) return { allowed: false, reason: `Tool '${name}' not available in this session` };
  if (policy.allowedTools.includes(name)) return { allowed: true };
  return { allowed: false, reason: `Tool '${name}' not available in this session` };
}

export function checkPath(filePath: string, mode: "read" | "write", policy: SandboxPolicy): CheckResult {
  // Resolve ~, normalize .., and resolve symlinks to prevent traversal attacks
  const expanded = filePath.replace(/^~/, homedir());
  const normalized = resolve(expanded);
  let abs: string;
  try { abs = realpathSync(normalized); } catch { abs = normalized; /* file may not exist yet (write) */ }

  const list = mode === "read" ? policy.allowedRead : policy.allowedWrite;
  // If wildcard, skip blacklist (owner sessions)
  if (list.length === 1 && list[0] === "*") return { allowed: true };
  // Blacklist always enforced for explicit path lists
  for (const blocked of PATH_BLACKLIST) {
    if (abs === blocked || abs.startsWith(blocked + "/")) {
      return { allowed: false, reason: `Path '${filePath}' is restricted` };
    }
  }
  if (list.length === 0) return { allowed: false, reason: `No ${mode} access in this session` };
  for (const prefix of list) {
    const absPrefix = resolve(prefix.replace(/^~/, homedir()));
    if (abs === absPrefix || abs.startsWith(absPrefix + "/")) return { allowed: true };
  }
  return { allowed: false, reason: `Path '${filePath}' not in allowed ${mode} paths` };
}

export function buildPolicy(source: "owner" | "peer" | "guest", config?: Partial<SandboxPolicy>): Readonly<SandboxPolicy> {
  let base: SandboxPolicy;
  switch (source) {
    case "owner":
      base = { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true };
      break;
    case "peer":
      base = { allowedTools: [], allowedRead: [], allowedWrite: [], canExecuteBash: false };
      break;
    case "guest":
      base = { allowedTools: ["web_fetch"], allowedRead: [], allowedWrite: [], canExecuteBash: false };
      break;
  }
  if (config) base = { ...base, ...config };
  return Object.freeze(base);
}

export function auditDeny(tool: string, path: string | undefined, policy: string, reason: string): void {
  const entry = { ts: Date.now(), event: "sandbox_deny", tool, path, policy, reason };
  try { appendFileSync(AUDIT_PATH, JSON.stringify(entry) + "\n"); } catch (err) { logAndSwallow("tool-sandbox", "audit write", err); }
}

// ── Tool Loop Guard ─────────────────────────────────────────────────────────

const IDEMPOTENT_TOOLS = new Set(["file_read", "web_fetch", "web_browse", "memory_recall"]);

function argsHash(name: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(name + JSON.stringify(args)).digest("hex");
}

export class ToolLoopGuard {
  private failCounts = new Map<string, number>();
  private resultCounts = new Map<string, number>();

  beforeCall(name: string, args: Record<string, unknown>): CheckResult {
    const hash = argsHash(name, args);
    const fails = this.failCounts.get(hash) ?? 0;
    if (fails >= 4) return { allowed: false, reason: `Tool '${name}' blocked: repeated identical failure (${fails} times)` };
    if (IDEMPOTENT_TOOLS.has(name)) {
      const repeats = this.resultCounts.get(hash) ?? 0;
      if (repeats >= 4) return { allowed: false, reason: `Tool '${name}' blocked: same result returned ${repeats} times — stuck loop` };
    }
    return { allowed: true };
  }

  afterCall(name: string, args: Record<string, unknown>, _result: string, failed: boolean): string | undefined {
    const hash = argsHash(name, args);
    if (failed) {
      const count = (this.failCounts.get(hash) ?? 0) + 1;
      this.failCounts.set(hash, count);
      if (count === 2) return "This tool call failed twice with identical arguments. Consider changing your approach.";
    } else if (IDEMPOTENT_TOOLS.has(name)) {
      const count = (this.resultCounts.get(hash) ?? 0) + 1;
      this.resultCounts.set(hash, count);
      if (count === 2) return "Same result returned twice for identical query. Use the result or change the query.";
    }
    return undefined;
  }

  resetForTurn(): void {
    this.failCounts.clear();
    this.resultCounts.clear();
  }
}
