/**
 * sha-policy.ts — validated SHA policy parsing and effective-value resolution
 * (#1688 Task 2, #1708 Task 1).
 *
 * Core policy lives at ~/.abtars/config/sha-policy.json; self-generated rules
 * at sha-policy-self.json. All parsed external data starts as `unknown` and is
 * validated before use. Core wins on duplicate patterns.
 *
 * #1708 ownership boundaries:
 *  - The CORE file is the only source allowed to configure Orc guardrails and
 *    log-anomaly admission. Self-policy contributes validated fix rules only;
 *    any self-generated guardrails/mode/admission fields are ignored.
 *  - This module owns validated CONFIGURATION only: one immutable effective
 *    snapshot with deterministic defaults, bounds, and fallbacks, plus the
 *    cache/reload operation. Live fuse state, counters, reset generations,
 *    attempt history, and task-occurrence terminality stay in their durable
 *    runtime stores — never here.
 *
 * schemaVersion rules:
 *  - absent  → legacy envelope (existing faults/fixes files): fixes usable,
 *              default guardrails;
 *  - 2       → guardrail sections are read leaf-by-leaf with bounded fallback;
 *  - other   → unsupported: shipped defaults, line-level AND anomaly policy
 *              admission disabled; structured scheduled classification stays
 *              independent;
 *  - missing or syntactically invalid file → same fail-closed behavior as
 *              unsupported, with one bounded diagnostic per load.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logWarn } from "../logger.js";
import { abtarsHome } from "../../paths.js";
import { DEFAULT_ORC_GUARDRAILS } from "../orc-project/orc-project-contracts.js";

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

// ── #1708 effective policy contract ──────────────────────────────────────────

/** Runtime self-heal modes that may gate anomaly admission (never "off":
 *  SELFHEAL_MODE=off always wins over any policy value). */
export type ShaMinimumMode = "investigation" | "full";

export interface EffectiveOrcGuardrails {
  readonly sameCard: {
    readonly failedOrNoProgress: { readonly max: number; readonly windowMinutes: number };
    readonly startsWithoutProgress: { readonly max: number; readonly windowMinutes: number };
  };
  readonly bridge: {
    readonly starts5m: number;
    readonly starts1h: number;
    readonly newRunRows5m: number;
  };
}

export interface EffectiveLogAnomalyPolicy {
  /** Independent of SELFHEAL_MODE: the producer warning stays eligible even
   *  when SHA admission is off. */
  readonly notifyMain: boolean;
  /** Sole policy admission gate for typed logAnomaly signals. */
  readonly shaAllowed: boolean;
  readonly minimumMode: ShaMinimumMode;
  /** Integer minutes, 60..1440. Policy may lengthen the shipped one-hour
   *  floor but cannot weaken it. */
  readonly cooldownMinutes: number;
}

export interface EffectiveShaPolicy {
  readonly fixes: readonly FixRule[];
  readonly logAdmissionAllowed: boolean;
  readonly orc: EffectiveOrcGuardrails;
  readonly logAnomaly: EffectiveLogAnomalyPolicy;
}

export type CorePolicyStatus =
  | "valid-v2"
  | "valid-legacy"
  | "missing"
  | "invalid-json"
  | "unsupported-schema";

export type SelfPolicyStatus = "valid" | "missing" | "invalid-json";

export interface PolicyDiagnostics {
  readonly coreStatus: CorePolicyStatus;
  readonly selfStatus: SelfPolicyStatus;
  /** Bounded field paths whose invalid leaves resolved to a default. */
  readonly fallbackFields: readonly string[];
}

export const ANOMALY_COOLDOWN_MIN_FLOOR = 60;
export const ANOMALY_COOLDOWN_MAX_MINUTES = 1440;
export const DEFAULT_LOG_ANOMALY_POLICY: EffectiveLogAnomalyPolicy = Object.freeze({
  notifyMain: true,
  shaAllowed: true,
  minimumMode: "investigation",
  cooldownMinutes: ANOMALY_COOLDOWN_MIN_FLOOR,
});
const DISABLED_LOG_ANOMALY_POLICY: EffectiveLogAnomalyPolicy = Object.freeze({
  ...DEFAULT_LOG_ANOMALY_POLICY,
  shaAllowed: false,
});

function freezeOrcGuardrails(value: EffectiveOrcGuardrails): EffectiveOrcGuardrails {
  return Object.freeze({
    sameCard: Object.freeze({
      failedOrNoProgress: Object.freeze({ ...value.sameCard.failedOrNoProgress }),
      startsWithoutProgress: Object.freeze({ ...value.sameCard.startsWithoutProgress }),
    }),
    bridge: Object.freeze({ ...value.bridge }),
  });
}

function freezeLogAnomalyPolicy(value: EffectiveLogAnomalyPolicy): EffectiveLogAnomalyPolicy {
  return Object.freeze({ ...value });
}

function freezeFixRule(value: FixRule): FixRule {
  return Object.freeze({
    ...value,
    ...(value.command ? { command: Object.freeze(value.command.slice()) } : {}),
    ...(value.verifyCommand ? { verifyCommand: Object.freeze(value.verifyCommand.slice()) } : {}),
  }) as FixRule;
}

// ── fix-rule validation (#1688, unchanged) ───────────────────────────────────

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

// ── raw file reading ─────────────────────────────────────────────────────────

type RawFileResult =
  | { status: "ok"; value: unknown }
  | { status: "missing" }
  | { status: "invalid-json" };

function readJsonFile(path: string): RawFileResult {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "missing" };
    return { status: "invalid-json" };
  }
  try {
    const value: unknown = JSON.parse(text);
    // A valid JSON scalar/array is not a policy document — fail closed.
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { status: "invalid-json" };
    }
    return { status: "ok", value };
  } catch {
    return { status: "invalid-json" };
  }
}

function policyPath(): string { return join(abtarsHome(), "config", "sha-policy.json"); }
function selfPolicyPath(): string { return join(abtarsHome(), "config", "sha-policy-self.json"); }

// ── leaf validators ──────────────────────────────────────────────────────────

interface LeafCtx {
  fallbacks: string[];
}

function resolveCountLeaf(raw: unknown, path: string, ceiling: number, ctx: LeafCtx): number {
  const ok = typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 && raw <= ceiling;
  if (ok) return raw;
  ctx.fallbacks.push(path);
  return ceiling;
}

function resolveBooleanLeaf(raw: unknown, path: string, fallback: boolean, ctx: LeafCtx): boolean {
  if (typeof raw === "boolean") return raw;
  ctx.fallbacks.push(path);
  return fallback;
}

function resolveMinimumModeLeaf(raw: unknown, path: string, ctx: LeafCtx): ShaMinimumMode {
  if (raw === "investigation" || raw === "full") return raw;
  ctx.fallbacks.push(path);
  return DEFAULT_LOG_ANOMALY_POLICY.minimumMode;
}

function resolveCooldownLeaf(raw: unknown, path: string, ctx: LeafCtx): number {
  const ok = typeof raw === "number"
    && Number.isSafeInteger(raw)
    && raw >= ANOMALY_COOLDOWN_MIN_FLOOR
    && raw <= ANOMALY_COOLDOWN_MAX_MINUTES;
  if (ok) return raw;
  ctx.fallbacks.push(path);
  return ANOMALY_COOLDOWN_MIN_FLOOR;
}

function asObject(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

/** Resolve Orc same-card/bridge guardrails leaf-by-leaf against the shipped
 *  defaults (which are also the immutable hard ceilings). Every missing or
 *  invalid leaf resolves to its default and records exactly one bounded
 *  field-path diagnostic per load. Windows are code-owned and not readable
 *  from policy. */
function resolveOrcGuardrails(rawOrc: unknown, ctx: LeafCtx): EffectiveOrcGuardrails {
  const d = DEFAULT_ORC_GUARDRAILS;
  const orc = asObject(rawOrc);
  if (!orc) {
    ctx.fallbacks.push("guardrails.orc");
    return d;
  }
  const sameCard = asObject(orc["sameCard"]);
  const failed = sameCard ? asObject(sameCard["failedOrNoProgress"]) : null;
  const starts = sameCard ? asObject(sameCard["startsWithoutProgress"]) : null;
  const bridge = asObject(orc["bridge"]);

  return {
    sameCard: {
      failedOrNoProgress: {
        max: resolveCountLeaf(failed?.["max"], "guardrails.orc.sameCard.failedOrNoProgress.max", d.sameCard.failedOrNoProgress.max, ctx),
        windowMinutes: d.sameCard.failedOrNoProgress.windowMinutes,
      },
      startsWithoutProgress: {
        max: resolveCountLeaf(starts?.["max"], "guardrails.orc.sameCard.startsWithoutProgress.max", d.sameCard.startsWithoutProgress.max, ctx),
        windowMinutes: d.sameCard.startsWithoutProgress.windowMinutes,
      },
    },
    bridge: {
      starts5m: resolveCountLeaf(bridge?.["starts5m"], "guardrails.orc.bridge.starts5m", d.bridge.starts5m, ctx),
      starts1h: resolveCountLeaf(bridge?.["starts1h"], "guardrails.orc.bridge.starts1h", d.bridge.starts1h, ctx),
      newRunRows5m: resolveCountLeaf(bridge?.["newRunRows5m"], "guardrails.orc.bridge.newRunRows5m", d.bridge.newRunRows5m, ctx),
    },
  };
}

/** Resolve the source-specific anomaly admission gate leaf-by-leaf. */
function resolveLogAnomalyPolicy(rawAnomaly: unknown, ctx: LeafCtx): EffectiveLogAnomalyPolicy {
  const d = DEFAULT_LOG_ANOMALY_POLICY;
  const la = asObject(rawAnomaly);
  if (!la) {
    ctx.fallbacks.push("guardrails.logAnomaly");
    return d;
  }
  return {
    notifyMain: resolveBooleanLeaf(la["notifyMain"], "guardrails.logAnomaly.notifyMain", d.notifyMain, ctx),
    shaAllowed: resolveBooleanLeaf(la["shaAllowed"], "guardrails.logAnomaly.shaAllowed", d.shaAllowed, ctx),
    minimumMode: resolveMinimumModeLeaf(la["minimumMode"], "guardrails.logAnomaly.minimumMode", ctx),
    cooldownMinutes: resolveCooldownLeaf(la["cooldownMinutes"], "guardrails.logAnomaly.cooldownMinutes", ctx),
  };
}

// ── full resolution ──────────────────────────────────────────────────────────

interface ResolvedSnapshot {
  snapshot: EffectiveShaPolicy;
  diagnostics: PolicyDiagnostics;
}

function parseFixList(root: Record<string, unknown>): FixRule[] {
  if (!Array.isArray(root["fixes"])) return [];
  const fixes: FixRule[] = [];
  for (const entry of root["fixes"]) {
    const rule = validateFixRule(entry);
    if (rule) fixes.push(rule);
  }
  return fixes;
}

function mergeSelfFixes(coreFixes: readonly FixRule[], selfRoot: Record<string, unknown>): FixRule[] {
  if (!Array.isArray(selfRoot["fixes"])) return [];
  const corePatterns = new Set(coreFixes.map((f) => f.pattern));
  const merged = [...coreFixes];
  for (const entry of selfRoot["fixes"]) {
    const rule = validateFixRule(entry);
    if (!rule) continue;
    if (corePatterns.has(rule.pattern)) continue;
    if (rule.pattern.length < MIN_PATTERN_LENGTH) {
      logWarn(TAG, `Self-fix pattern too short, ignored: "${rule.pattern}"`);
      continue;
    }
    if (rule.enabled === false) continue;
    merged.push(rule);
  }
  return merged;
}

/**
 * Resolve both policy files into one complete immutable snapshot plus bounded
 * diagnostics. Pure w.r.t. module state: no caching happens here, so a reload
 * publishes either this complete result or nothing at all.
 */
function resolveAll(): ResolvedSnapshot {
  const core = readJsonFile(policyPath());
  const self = readJsonFile(selfPolicyPath());
  const fallbacks: string[] = [];
  const ctx: LeafCtx = { fallbacks };

  let coreStatus: CorePolicyStatus;
  let coreFixes: readonly FixRule[] = [];
  let orc = DEFAULT_ORC_GUARDRAILS;
  let logAnomaly = DEFAULT_LOG_ANOMALY_POLICY;
  let logAdmissionAllowed = false;

  switch (core.status) {
    case "missing":
    case "invalid-json": {
      coreStatus = core.status;
      logAnomaly = DISABLED_LOG_ANOMALY_POLICY;
      break;
    }
    case "ok": {
      const root = core.value as Record<string, unknown>;
      const version = root["schemaVersion"];
      if (version === undefined) {
        coreStatus = "valid-legacy";
        coreFixes = parseFixList(root);
        logAdmissionAllowed = true;
      } else if (version === 2) {
        coreStatus = "valid-v2";
        coreFixes = parseFixList(root);
        logAdmissionAllowed = true;
        const guardrails = asObject(root["guardrails"]);
        if (guardrails) {
          orc = resolveOrcGuardrails(guardrails["orc"], ctx);
          logAnomaly = resolveLogAnomalyPolicy(guardrails["logAnomaly"], ctx);
        } else {
          ctx.fallbacks.push("guardrails");
          orc = DEFAULT_ORC_GUARDRAILS;
          logAnomaly = DEFAULT_LOG_ANOMALY_POLICY;
        }
      } else {
        coreStatus = "unsupported-schema";
        logAnomaly = DISABLED_LOG_ANOMALY_POLICY;
      }
      break;
    }
  }

  if (coreStatus === "valid-v2" && fallbacks.length > 0) {
    logWarn(TAG, `policy guardrail fallback (${fallbacks.length}): ${fallbacks.join("; ")}`);
  } else if (coreStatus !== "valid-v2" && coreStatus !== "valid-legacy") {
    logWarn(TAG, `core policy ${coreStatus} — line-level and anomaly SHA admission disabled until reload/restart (scheduled classification unaffected)`);
  }

  let selfStatus: SelfPolicyStatus;
  let fixes: readonly FixRule[];
  switch (self.status) {
    case "missing":
      selfStatus = "missing";
      fixes = coreFixes;
      break;
    case "invalid-json":
      selfStatus = "invalid-json";
      fixes = coreFixes;
      break;
    case "ok": {
      selfStatus = "valid";
      // Self guardrails/mode/admission fields are ignored by construction:
      // only the fixes list is read from the self file.
      fixes = mergeSelfFixes(coreFixes, self.value as Record<string, unknown>);
      break;
    }
  }

  const snapshot: EffectiveShaPolicy = Object.freeze({
    fixes: Object.freeze(fixes.map(freezeFixRule)),
    logAdmissionAllowed,
    orc: freezeOrcGuardrails(orc),
    logAnomaly: freezeLogAnomalyPolicy(logAnomaly),
  });
  return {
    snapshot,
    diagnostics: Object.freeze({
      coreStatus,
      selfStatus,
      fallbackFields: Object.freeze(fallbacks.slice()),
    }),
  };
}

// ── cache / reload ───────────────────────────────────────────────────────────

let cachedEffective: ResolvedSnapshot | null = null;

/** Publish atomically: readers see either the previous complete snapshot or
 *  the next complete snapshot — never a partially rebuilt one. */
function publish(resolved: ResolvedSnapshot): void {
  cachedEffective = resolved;
}

function ensureResolved(): ResolvedSnapshot {
  if (!cachedEffective) publish(resolveAll());
  return cachedEffective!;
}

/** Cached immutable effective policy. First use loads from disk (normal
 *  restart behavior); later reads reuse the snapshot until an explicit
 *  reload, a self-policy write, or process restart. */
export function getEffectiveShaPolicy(): EffectiveShaPolicy {
  return ensureResolved().snapshot;
}

/** Effective Orc guardrail limits for the claim store and operator surfaces. */
export function getEffectiveOrcGuardrails(): EffectiveOrcGuardrails {
  return ensureResolved().snapshot.orc;
}

/** Source-specific anomaly admission policy. */
export function getLogAnomalyPolicy(): EffectiveLogAnomalyPolicy {
  return ensureResolved().snapshot.logAnomaly;
}

/** Bounded validity/source information for /healing reload and status. */
export function policyDiagnostics(): PolicyDiagnostics {
  return ensureResolved().diagnostics;
}

/**
 * Synchronously re-resolve both files and atomically publish the replacement
 * snapshot. A malformed edit publishes safe defaults rather than retaining a
 * previously valid snapshot. Returns what was published.
 */
export function reloadEffectiveShaPolicy(): ResolvedSnapshot {
  const resolved = resolveAll();
  publish(resolved);
  return resolved;
}

// ── legacy-compatible accessors (#1688 surface, now snapshot-backed) ────────

/** Validated merged fixes from core + self. Core wins on duplicate patterns. */
export function loadMergedFixes(): FixRule[] {
  return getEffectiveShaPolicy().fixes.slice();
}

/** #1688 R2/R3: whether the log scanner may admit (false when policy is corrupt). */
export function logAdmissionAllowed(): boolean {
  return getEffectiveShaPolicy().logAdmissionAllowed;
}

export function isPolicyCorrupt(): boolean {
  const status = policyDiagnostics().coreStatus;
  return status !== "valid-v2" && status !== "valid-legacy";
}

/** Clear the cache entirely; the next read re-resolves from disk. */
export function reload(): void {
  cachedEffective = null;
}

// ── self-policy writes ───────────────────────────────────────────────────────

function loadSelfFileForWrite(): Record<string, unknown> | null {
  const result = readJsonFile(selfPolicyPath());
  return result.status === "ok" ? result.value as Record<string, unknown> : null;
}

/** Approve a self-generated fix rule (mark verified). */
export function approveFix(pattern: string): boolean {
  const selfPolicy = loadSelfFileForWrite();
  if (!selfPolicy) return false;
  if (!Array.isArray(selfPolicy.fixes)) selfPolicy.fixes = [];
  const rules = parseFixList({ fixes: selfPolicy.fixes });
  const rule = rules.find((f) => f.pattern === pattern);
  if (!rule) return false;
  const updated = rules.map((f) => (f.pattern === pattern ? { ...f, verified: true } : f));
  selfPolicy.fixes = updated;
  writeSelfPolicy(selfPolicy);
  reloadEffectiveShaPolicy();
  return true;
}

/** Disable a self-generated fix rule. */
export function disableFix(pattern: string): boolean {
  const selfPolicy = loadSelfFileForWrite();
  if (!selfPolicy) return false;
  if (!Array.isArray(selfPolicy.fixes)) selfPolicy.fixes = [];
  const rules = parseFixList({ fixes: selfPolicy.fixes });
  const rule = rules.find((f) => f.pattern === pattern);
  if (!rule) return false;
  const updated = rules.map((f) => (f.pattern === pattern ? { ...f, enabled: false } : f));
  selfPolicy.fixes = updated;
  writeSelfPolicy(selfPolicy);
  reloadEffectiveShaPolicy();
  return true;
}

function writeSelfPolicy(policy: Record<string, unknown>): void {
  const dir = join(abtarsHome(), "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(selfPolicyPath(), JSON.stringify(policy, null, 2) + "\n");
}
