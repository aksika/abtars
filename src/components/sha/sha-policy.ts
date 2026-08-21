/**
 * sha-policy.ts — validated SHA fix-rule policy parsing (#1688 Task 2).
 *
 * Core policy lives at ~/.abtars/config/sha-policy.json; self-generated rules
 * at sha-policy-self.json. All parsed external data starts as `unknown` and is
 * validated before use. Core wins on duplicate patterns. A malformed/missing
 * core policy logs once and disables LOG-source admission only; structured
 * scheduled-failure classification remains independent.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logWarn } from "../logger.js";
import { abtarsHome } from "../../paths.js";

const TAG = "sha-policy";
export const MIN_PATTERN_LENGTH = 10;

export interface FixRule {
  pattern: string;
  action?: "run" | "suppress";
  command?: string[];
  /** #1688 R8: independent verifier argv; required for automatic execution. */
  verifyCommand?: string[];
  cooldownMin: number;
  verified?: boolean;
  createdAt?: string;
  report?: string;
  enabled?: boolean;
}

interface PolicyFile {
  faults?: Record<string, unknown>;
  fixes?: unknown;
}

/** Validate one rule from unknown. Returns null for any malformed input. */
export function validateFixRule(raw: unknown): FixRule | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["pattern"] !== "string" || r["pattern"].trim().length === 0) return null;
  const action = r["action"];
  if (action !== undefined && action !== "run" && action !== "suppress") return null;
  const command = r["command"];
  if (command !== undefined && (!Array.isArray(command) || command.some((c) => typeof c !== "string") || command.length === 0)) return null;
  const verifyCommand = r["verifyCommand"];
  if (verifyCommand !== undefined && (!Array.isArray(verifyCommand) || verifyCommand.some((c) => typeof c !== "string") || verifyCommand.length === 0)) return null;
  const cooldownMin = r["cooldownMin"];
  if (typeof cooldownMin !== "number" || !Number.isFinite(cooldownMin) || cooldownMin < 0) return null;
  if (r["verified"] !== undefined && typeof r["verified"] !== "boolean") return null;
  if (r["createdAt"] !== undefined && typeof r["createdAt"] !== "string") return null;
  if (r["report"] !== undefined && typeof r["report"] !== "string") return null;
  if (r["enabled"] !== undefined && typeof r["enabled"] !== "boolean") return null;
  return {
    pattern: r["pattern"],
    action,
    ...(command !== undefined ? { command } : {}),
    ...(verifyCommand !== undefined ? { verifyCommand } : {}),
    cooldownMin,
    ...(r["verified"] !== undefined ? { verified: r["verified"] } : {}),
    ...(r["createdAt"] !== undefined ? { createdAt: r["createdAt"] } : {}),
    ...(r["report"] !== undefined ? { report: r["report"] } : {}),
    ...(r["enabled"] !== undefined ? { enabled: r["enabled"] } : {}),
  };
}

let cachedCore: PolicyFile | null = null;
let cachedSelf: PolicyFile | null = null;
let policyCorrupt = false;
let logAdmissionDisabled = false;
let corruptLogged = false;

function policyPath(): string { return join(abtarsHome(), "config", "sha-policy.json"); }
function selfPolicyPath(): string { return join(abtarsHome(), "config", "sha-policy-self.json"); }

function parseFixes(raw: unknown): FixRule[] {
  if (typeof raw !== "object" || raw === null) return [];
  if (!Array.isArray((raw as Record<string, unknown>)["fixes"])) return [];
  const fixes: FixRule[] = [];
  for (const entry of (raw as Record<string, unknown>)["fixes"] as unknown[]) {
    const rule = validateFixRule(entry);
    if (rule) fixes.push(rule);
  }
  return fixes;
}

function loadPolicy(): PolicyFile | null {
  if (cachedCore) return cachedCore;
  try {
    cachedCore = JSON.parse(readFileSync(policyPath(), "utf-8")) as PolicyFile;
    policyCorrupt = false;
    return cachedCore;
  } catch {
    if (!corruptLogged) {
      logWarn(TAG, "sha-policy.json missing or invalid — log-source admission disabled until restart (scheduled classification unaffected)");
      corruptLogged = true;
    }
    policyCorrupt = true;
    logAdmissionDisabled = true;
    return null;
  }
}

function loadSelfPolicy(): PolicyFile | null {
  if (cachedSelf) return cachedSelf;
  try {
    cachedSelf = JSON.parse(readFileSync(selfPolicyPath(), "utf-8")) as PolicyFile;
    return cachedSelf;
  } catch {
    return null;
  }
}

/** Validated merged fixes from core + self. Core wins on duplicate patterns. */
export function loadMergedFixes(): FixRule[] {
  const policy = loadPolicy();
  const coreFixes = policy ? parseFixes(policy) : [];
  const selfPolicy = loadSelfPolicy();
  const selfFixes = selfPolicy ? parseFixes(selfPolicy) : [];
  const corePatterns = new Set(coreFixes.map((f) => f.pattern));
  const merged = [...coreFixes];
  for (const f of selfFixes) {
    if (corePatterns.has(f.pattern)) continue;
    if (f.pattern.length < MIN_PATTERN_LENGTH) {
      logWarn(TAG, `Self-fix pattern too short, ignored: "${f.pattern}"`);
      continue;
    }
    if (f.enabled === false) continue;
    merged.push(f);
  }
  return merged;
}

/** #1688 R2/R3: whether the log scanner may admit (false when policy is corrupt). */
export function logAdmissionAllowed(): boolean {
  loadPolicy();
  return !logAdmissionDisabled;
}

/** Approve a self-generated fix rule (mark verified). */
export function approveFix(pattern: string): boolean {
  const selfPolicy = loadSelfPolicy();
  if (!selfPolicy) return false;
  if (!Array.isArray(selfPolicy.fixes)) selfPolicy.fixes = [];
  const rules = parseFixes({ fixes: selfPolicy.fixes });
  const rule = rules.find((f) => f.pattern === pattern);
  if (!rule) return false;
  const updated = rules.map((f) => (f.pattern === pattern ? { ...f, verified: true } : f));
  selfPolicy.fixes = updated;
  writeSelfPolicy(selfPolicy);
  cachedSelf = null;
  return true;
}

/** Disable a self-generated fix rule. */
export function disableFix(pattern: string): boolean {
  const selfPolicy = loadSelfPolicy();
  if (!selfPolicy) return false;
  if (!Array.isArray(selfPolicy.fixes)) selfPolicy.fixes = [];
  const rules = parseFixes({ fixes: selfPolicy.fixes });
  const rule = rules.find((f) => f.pattern === pattern);
  if (!rule) return false;
  const updated = rules.map((f) => (f.pattern === pattern ? { ...f, enabled: false } : f));
  selfPolicy.fixes = updated;
  writeSelfPolicy(selfPolicy);
  cachedSelf = null;
  return true;
}

function writeSelfPolicy(policy: PolicyFile): void {
  const dir = join(abtarsHome(), "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(selfPolicyPath(), JSON.stringify(policy, null, 2) + "\n");
}

export function isPolicyCorrupt(): boolean { return policyCorrupt; }

export function reload(): void {
  cachedCore = null;
  cachedSelf = null;
  policyCorrupt = false;
  logAdmissionDisabled = false;
  corruptLogged = false;
}