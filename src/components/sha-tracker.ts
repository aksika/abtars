/**
 * SHA Fault Tracker — configurable self-healing cooldowns (#854).
 *
 * Policy: ~/.abtars/config/sha-policy.json (shipped via configSeeds)
 * State:  ~/.abtars/state/sha-state.json (runtime, deletable for fresh start)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logDebug, logWarn } from "./logger.js";

const TAG = "sha";

interface FaultPolicy {
  action: string;
  cooldown: number;
  maxRetries: number;
}

interface FaultState {
  lastAttempt: string;
  attempts: number;
  result: "failed" | "ok";
  error?: string;
}

interface PolicyFile { faults: Record<string, FaultPolicy>; }
type StateFile = Record<string, FaultState>;

let cachedPolicy: PolicyFile | null = null;

function abtarsHome(): string {
  return process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars");
}

function policyPath(): string { return join(abtarsHome(), "config", "sha-policy.json"); }
function statePath(): string { return join(abtarsHome(), "state", "sha-state.json"); }

function loadPolicy(): PolicyFile | null {
  if (cachedPolicy) return cachedPolicy;
  try {
    cachedPolicy = JSON.parse(readFileSync(policyPath(), "utf-8"));
    return cachedPolicy;
  } catch {
    logWarn(TAG, "sha-policy.json missing or invalid — allowing all attempts");
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

export function shouldAttempt(faultId: string, scope: string): boolean {
  const policy = loadPolicy();
  if (!policy) return true; // no policy = allow all

  const rule = policy.faults[faultId];
  if (!rule) return true; // unknown fault = allow

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
    // Cooldown expired — allow retry
  }
  return true;
}

export function recordResult(faultId: string, scope: string, ok: boolean, error?: string): void {
  const key = `${faultId}:${scope}`;
  const state = loadState();
  const entry = state[key];

  if (ok) {
    // Success — reset
    delete state[key];
  } else {
    state[key] = {
      lastAttempt: new Date().toISOString(),
      attempts: (entry?.attempts ?? 0) + 1,
      result: "failed",
      error,
    };
  }
  saveState(state);
  logDebug(TAG, `${key}: ${ok ? "ok (reset)" : `failed (attempt ${state[key]?.attempts})`}`);
}

export function reload(): void {
  cachedPolicy = null;
  loadPolicy();
}
