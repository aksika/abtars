/**
 * tool-sandbox.ts — session tool-availability policy, loop guardrails, and
 * sandbox-deny audit rows. Path policy (#1851) lives in authorization.ts.
 */

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

export function buildPolicy(source: "owner" | "peer", config?: Partial<SandboxPolicy>): Readonly<SandboxPolicy> {
  let base: SandboxPolicy;
  switch (source) {
    case "owner":
      base = { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true };
      break;
    case "peer":
      base = { allowedTools: [], allowedRead: [], allowedWrite: [], canExecuteBash: false };
      break;
  }
  if (config) base = { ...base, ...config };
  return Object.freeze(base);
}

export function auditDeny(tool: string, path: string | undefined, policy: string, reason: string, rootCardId?: number): void {
  const entry = { ts: Date.now(), event: "sandbox_deny", tool, path, policy, reason, ...(rootCardId !== undefined ? { rootCardId } : {}) };
  try { appendFileSync(AUDIT_PATH, JSON.stringify(entry) + "\n"); } catch (err) { logAndSwallow("tool-sandbox", "audit write", err); }
}

// ── Tool Loop Guard ─────────────────────────────────────────────────────────

const IDEMPOTENT_TOOLS = new Set(["file_read", "web_fetch", "memory_recall"]);

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
