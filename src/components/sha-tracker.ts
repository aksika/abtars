/**
 * SHA Fault Tracker — configurable self-healing cooldowns (#854, #954).
 *
 * Policy: ~/.abtars/config/sha-policy.json (shipped via configSeeds)
 * Self:   ~/.abtars/config/sha-policy-self.json (agent-generated, preserved across updates)
 * State:  ~/.abtars/state/sha-state.json (runtime, deletable for fresh start)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logDebug, logWarn } from "./logger.js";

const TAG = "sha";
const MIN_PATTERN_LENGTH = 10;

interface FaultPolicy {
  action: string;
  cooldown: number;
  maxRetries: number;
}

export interface FixRule {
  pattern: string;
  command: string[];
  cooldownMin: number;
  verified?: boolean;
  createdAt?: string;
  report?: string;
  enabled?: boolean;
}

interface FaultState {
  lastAttempt: string;
  attempts: number;
  result: "failed" | "ok";
  error?: string;
  totalRuns: number;
  lastRunAt: string;
}

interface PolicyFile {
  faults: Record<string, FaultPolicy>;
  fixes?: FixRule[];
}

interface SelfPolicyFile {
  fixes?: FixRule[];
}

type StateFile = Record<string, FaultState>;

let cachedPolicy: PolicyFile | null = null;
let policyCorrupt = false;

function abtarsHome(): string {
  return process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars");
}

function policyPath(): string { return join(abtarsHome(), "config", "sha-policy.json"); }
function selfPolicyPath(): string { return join(abtarsHome(), "config", "sha-policy-self.json"); }
function statePath(): string { return join(abtarsHome(), "state", "sha-state.json"); }

function loadPolicy(): PolicyFile | null {
  if (cachedPolicy) return cachedPolicy;
  try {
    cachedPolicy = JSON.parse(readFileSync(policyPath(), "utf-8"));
    policyCorrupt = false;
    return cachedPolicy;
  } catch {
    logWarn(TAG, "sha-policy.json missing or invalid — denying all attempts (circuit breaker)");
    policyCorrupt = true;
    return null;
  }
}

function loadSelfPolicy(): SelfPolicyFile | null {
  try {
    return JSON.parse(readFileSync(selfPolicyPath(), "utf-8"));
  } catch {
    return null;
  }
}

function loadState(): StateFile {
  try {
    return JSON.parse(readFileSync(statePath(), "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state: StateFile): void {
  const dir = join(abtarsHome(), "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n");
}

/** Load merged fixes from core + self. Core wins on duplicate patterns. */
export function loadFixes(): FixRule[] {
  const policy = loadPolicy();
  const coreFixes = policy?.fixes ?? [];
  const selfPolicy = loadSelfPolicy();
  const selfFixes = (selfPolicy?.fixes ?? []).filter(f => {
    if (f.pattern.length < MIN_PATTERN_LENGTH) {
      logWarn(TAG, `Self-fix pattern too short, ignored: "${f.pattern}"`);
      return false;
    }
    if (f.enabled === false) return false;
    return true;
  });
  // Core wins on duplicate patterns
  const corePatterns = new Set(coreFixes.map(f => f.pattern));
  const merged = [...coreFixes, ...selfFixes.filter(f => !corePatterns.has(f.pattern))];
  return merged;
}

export function shouldAttempt(faultId: string, scope: string): boolean {
  const policy = loadPolicy();
  if (!policy) return false; // corrupt/missing = deny all (circuit breaker)

  const rule = policy.faults[faultId];
  if (!rule) return true; // unknown fault type = allow

  const key = `${faultId}:${scope}`;
  const state = loadState();
  const entry = state[key];
  if (!entry) return true; // never attempted = allow

  if (entry.attempts >= rule.maxRetries) {
    const elapsed = Date.now() - new Date(entry.lastAttempt).getTime();
    if (elapsed < rule.cooldown * 1000) {
      logDebug(TAG, `${key}: suppressed (${entry.attempts}/${rule.maxRetries}, cooldown ${Math.round((rule.cooldown * 1000 - elapsed) / 60000)}min remaining)`);
      return false;
    }
    // Cooldown expired — reset attempts, allow retry
  }
  return true;
}

export function recordResult(faultId: string, scope: string, ok: boolean, error?: string): void {
  const key = `${faultId}:${scope}`;
  const state = loadState();
  const entry = state[key];
  const now = new Date().toISOString();
  const totalRuns = (entry?.totalRuns ?? 0) + 1;

  if (ok) {
    state[key] = { lastAttempt: now, attempts: 0, result: "ok", totalRuns, lastRunAt: now };
  } else {
    state[key] = {
      lastAttempt: now,
      attempts: (entry?.attempts ?? 0) + 1,
      result: "failed",
      error,
      totalRuns,
      lastRunAt: now,
    };
  }
  saveState(state);
  logDebug(TAG, `${key}: ${ok ? "ok" : `failed (attempt ${state[key]?.attempts})`} [total: ${totalRuns}]`);
}

/** Write a new fix rule to sha-policy-self.json */
export function addSelfFix(rule: Omit<FixRule, "verified" | "createdAt"> & { report?: string }): void {
  const selfPolicy = loadSelfPolicy() ?? { fixes: [] };
  if (!selfPolicy.fixes) selfPolicy.fixes = [];
  // Don't duplicate
  if (selfPolicy.fixes.some(f => f.pattern === rule.pattern)) return;
  selfPolicy.fixes.push({ ...rule, verified: false, createdAt: new Date().toISOString() });
  const dir = join(abtarsHome(), "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(selfPolicyPath(), JSON.stringify(selfPolicy, null, 2) + "\n");
}

/** Approve a self-generated fix rule (mark verified) */
export function approveFix(pattern: string): boolean {
  const selfPolicy = loadSelfPolicy();
  if (!selfPolicy?.fixes) return false;
  const rule = selfPolicy.fixes.find(f => f.pattern === pattern);
  if (!rule) return false;
  rule.verified = true;
  writeFileSync(selfPolicyPath(), JSON.stringify(selfPolicy, null, 2) + "\n");
  return true;
}

/** Disable a self-generated fix rule */
export function disableFix(pattern: string): boolean {
  const selfPolicy = loadSelfPolicy();
  if (!selfPolicy?.fixes) return false;
  const rule = selfPolicy.fixes.find(f => f.pattern === pattern);
  if (!rule) return false;
  rule.enabled = false;
  writeFileSync(selfPolicyPath(), JSON.stringify(selfPolicy, null, 2) + "\n");
  return true;
}

/** Clear autofix entries from state (for /healing reset) */
export function resetAutofixState(): void {
  const state = loadState();
  for (const key of Object.keys(state)) {
    if (key.startsWith("autofix-")) delete state[key];
  }
  saveState(state);
}

export function isPolicyCorrupt(): boolean { return policyCorrupt; }

export function reload(): void {
  cachedPolicy = null;
  policyCorrupt = false;
  loadPolicy();
}
