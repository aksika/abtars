/**
 * sha-classifier.ts — pure SHA failure classification, normalization, and
 * fingerprinting (#1688 Task 2).
 *
 * No database, notification, Kanban, Worker, or provider imports. Guard
 * precedence (R3): mode off → system TaskKind → provider credits → structured
 * external/authorization outage → ambiguity → policy suppression/known fix →
 * unknown actionable admission. Structured scheduled fields always win over
 * message content.
 */
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { redactSecrets } from "../logger.js";
import type { FixRule } from "./sha-policy.js";
import type {
  LogAnomalyEvent,
  LogFailureEvent,
  ScheduledFailureEvent,
  ShaClassification,
  ShaClassificationResult,
  SelfHealMode,
} from "./sha-types.js";
import type { TaskFailureDiagnosticV1 } from "../tasks/task-failure.js";

/** #1688 R2: evidence bound (2 KiB) and diagnostic JSON bound (8 KiB). */
export const MAX_EVIDENCE_BYTES = 2048;
export const MAX_DIAGNOSTIC_JSON_BYTES = 8192;

/** #1708: active-log path bound for typed anomaly events. */
export const MAX_LOG_PATH_BYTES = 1024;

const RECURSION_TAGS: readonly string[] = ["self-healer", "self_healer", "sha-", "watchdog"];

const EXTERNAL_LOG_RE = /(network|connection refused|connection reset|econnrefused|econnreset|enotfound|etimedout|socket hang|unauthorized|authentication failed|tls|ssl|dns|proxy|timeout)/i;

export interface ShaPolicyView {
  readonly fixes: readonly FixRule[];
  readonly logAdmissionAllowed: boolean;
  /**
   * #1708: source-specific anomaly admission gate. Present whenever the
   * effective policy was resolved (defaults apply for legacy/corrupt files);
   * admission additionally requires the runtime mode.
   */
  readonly logAnomaly?: Readonly<{
    readonly shaAllowed: boolean;
    readonly minimumMode: "investigation" | "full";
    readonly cooldownMinutes: number;
  }>;
}

/** #1708: runtime mode rank for minimum-mode gates: off < investigation < full. */
export function selfHealModeRank(mode: SelfHealMode): 0 | 1 | 2 {
  return mode === "off" ? 0 : mode === "investigation" ? 1 : 2;
}

/** Normalize a log/diagnostic message: redact secrets, timestamps, long hex
 *  IDs, large numbers, absolute home paths; collapse whitespace. */
export function normalizeFailureMessage(message: string): string {
  return redactSecrets(message)
    .replace(/\b[0-9a-f]{8,}\b/gi, "X")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?/g, "T")
    .replace(/\b\d{4,}\b/g, "N")
    .replace(/\/home\/[^/\s]+/g, "/home/<u>")
    .replace(/\s+/g, " ")
    .trim();
}

/** Canonical JSON: stable, sorted object keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 of the canonical UTF-8 representation. */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf-8").digest("hex");
}

/** #1688 R2: scheduled fingerprint — excludes run/card IDs, timestamps, secrets. */
export function scheduledFingerprint(event: ScheduledFailureEvent): string {
  return canonicalHash({
    schema: "sha-fp-v1",
    kind: "scheduled",
    entryId: event.entryId,
    taskKind: event.taskKind,
    category: event.diagnostic.category,
    code: event.diagnostic.code,
    phase: event.diagnostic.phase,
    scope: normalizeFailureMessage(event.diagnostic.message),
  });
}

/** #1688 R2: log fingerprint — component/tag + normalized redacted message. */
export function logFingerprint(event: LogFailureEvent): string {
  return canonicalHash({
    schema: "sha-fp-v1",
    kind: "log",
    component: event.component,
    tag: event.tag,
    message: event.normalizedMessage,
  });
}

/** #1688 R2: event keys — scheduled carries run identity; log carries cursor identity. */
export function scheduledEventKey(event: ScheduledFailureEvent): string {
  return `task:${event.entryId}:run:${event.runId}`;
}

export function logEventKey(event: LogFailureEvent): string {
  return `log:${canonicalHash(event.logPath)}:${event.inode}:${event.lineOffset}`;
}

// ── #1708: typed log-anomaly validation, identity, and classification ───────

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

export type LogAnomalyValidation =
  | { ok: true; event: LogAnomalyEvent }
  | { ok: false; reason: string };

/**
 * Pure boundary validation for a producer-supplied anomaly event. Returns a
 * bounded reason instead of throwing; the coordinator maps invalid events to
 * a no-write suppressed/ambiguous outcome before any store access.
 */
export function validateLogAnomalyEvent(raw: unknown): LogAnomalyValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "not an object" };
  }
  const r = raw as Record<string, unknown>;
  if (r["source"] !== "logAnomaly") return { ok: false, reason: "wrong source" };
  if (r["schemaVersion"] !== 1) return { ok: false, reason: "unsupported schemaVersion" };
  if (r["anomalyKind"] !== "growth_rate") return { ok: false, reason: "unsupported anomalyKind" };

  const logPath = r["logPath"];
  if (typeof logPath !== "string" || logPath.length === 0
    || !isAbsolute(logPath) || resolve(logPath) !== logPath) {
    return { ok: false, reason: "logPath must be absolute and normalized" };
  }
  if (utf8ByteLength(logPath) > MAX_LOG_PATH_BYTES) {
    return { ok: false, reason: "logPath over byte bound" };
  }

  const inode = r["inode"];
  if (typeof inode !== "number" || !Number.isSafeInteger(inode) || inode < 0) {
    return { ok: false, reason: "invalid inode" };
  }

  const episodeStartedAt = r["episodeStartedAt"];
  const windowStartedAt = r["windowStartedAt"];
  const windowEndedAt = r["windowEndedAt"];
  if ([episodeStartedAt, windowStartedAt, windowEndedAt]
    .some((t) => typeof t !== "number" || !Number.isSafeInteger(t))) {
    return { ok: false, reason: "timestamps must be safe integers" };
  }
  const t0 = episodeStartedAt as number;
  const t1 = windowStartedAt as number;
  const t2 = windowEndedAt as number;
  if (t0 > t1 || t1 >= t2) {
    return { ok: false, reason: "timestamps must satisfy episode <= windowStart < windowEnd" };
  }

  const sampleCount = r["sampleCount"];
  if (typeof sampleCount !== "number" || !Number.isSafeInteger(sampleCount) || sampleCount < 2) {
    return { ok: false, reason: "sampleCount must be a safe integer >= 2" };
  }

  const baseline = r["baselineBytesPerMinute"];
  const observed = r["observedBytesPerMinute"];
  const ratio = r["ratio"];
  if (typeof baseline !== "number" || !Number.isFinite(baseline) || baseline <= 0) {
    return { ok: false, reason: "baseline rate must be finite and positive" };
  }
  if (typeof observed !== "number" || !Number.isFinite(observed) || observed < 0) {
    return { ok: false, reason: "observed rate must be finite and non-negative" };
  }
  if (observed < baseline) {
    return { ok: false, reason: "observed rate below baseline is not growth" };
  }
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 1) {
    return { ok: false, reason: "ratio must be finite and >= 1" };
  }
  const expectedRatio = observed / baseline;
  const tolerance = Math.max(1, Math.abs(expectedRatio)) * 1e-6;
  if (Math.abs(ratio - expectedRatio) > tolerance) {
    return { ok: false, reason: "ratio inconsistent with observed/baseline" };
  }

  const evidence = r["evidence"];
  if (typeof evidence !== "string" || utf8ByteLength(evidence) > MAX_EVIDENCE_BYTES) {
    return { ok: false, reason: "evidence missing or over byte bound" };
  }

  return {
    ok: true,
    event: {
      source: "logAnomaly",
      schemaVersion: 1,
      anomalyKind: "growth_rate",
      logPath,
      inode,
      episodeStartedAt: t0,
      windowStartedAt: t1,
      windowEndedAt: t2,
      sampleCount,
      baselineBytesPerMinute: baseline,
      observedBytesPerMinute: observed,
      ratio,
      evidence,
    },
  };
}

/**
 * #1708: full lowercase SHA-256 hex of the canonical path's UTF-8 bytes.
 * This hash is both the logical-log scope and the cooldown scope, so inode
 * rotation can neither fork the fault nor bypass cooldown.
 */
export function logAnomalyPathHash(event: LogAnomalyEvent): string {
  return createHash("sha256").update(event.logPath, "utf-8").digest("hex");
}

/**
 * #1708: logical-log fingerprint — schema, kind, anomaly kind, canonical path
 * ONLY. Inode, rates, timestamps, and evidence are excluded so rotation or a
 * re-sample cannot create a second active logical-log fault.
 */
export function logAnomalyFingerprint(event: LogAnomalyEvent): string {
  return canonicalHash({
    schema: "sha-fp-v1",
    kind: "log-anomaly",
    anomalyKind: event.anomalyKind,
    logPath: event.logPath,
  });
}

/** #1708: episode event key — path hash + inode + episode start. */
export function logAnomalyEventKey(event: LogAnomalyEvent): string {
  return `log-anomaly:${logAnomalyPathHash(event)}:${event.inode}:${event.episodeStartedAt}`;
}

/** #1708: durable source scope (and cooldown scope) for an anomaly episode. */
export function logAnomalySourceScope(event: LogAnomalyEvent): string {
  return `log-anomaly:${logAnomalyPathHash(event)}`;
}

/** #1688 R3: structured external/authorization outage — never message text. */
function isExternalScheduled(d: TaskFailureDiagnosticV1): boolean {
  if (d.category === "routing") return true;
  if (d.category === "dependency" && (d.code === "adapter_unavailable" || d.code === "probe_failed")) return true;
  return false;
}

/** Pure exhaustive classification. Never reads env, store, or platform state. */
export function classifyShaFailure(
  signal: ScheduledFailureEvent | LogFailureEvent | LogAnomalyEvent,
  mode: SelfHealMode,
  policy: ShaPolicyView,
): ShaClassificationResult {
  if (mode === "off") return { classification: "suppressed", reason: "mode off" };
  if (signal.source === "scheduled") return classifyScheduled(signal, policy);
  if (signal.source === "logAnomaly") return classifyLogAnomaly(signal, mode, policy);
  return classifyLog(signal, policy);
}

function classifyScheduled(event: ScheduledFailureEvent, policy: ShaPolicyView): ShaClassificationResult {
  if (event.taskKind === "system") {
    return { classification: "system", reason: `system-kind task (${event.taskKind}) is outside SHA remediation authority` };
  }
  const d = event.diagnostic;
  if (d.category === "execution" && d.code === "credits_exhausted") {
    return { classification: "credits", reason: "provider credits exhausted — human remediation required" };
  }
  if (isExternalScheduled(d)) {
    return { classification: "external", reason: `structured external/authorization outage (${d.category}/${d.code})` };
  }
  if (d.message.length === 0 || d.message.length > 500) {
    return { classification: "ambiguous", reason: "empty or overlong diagnostic message" };
  }
  const rule = matchingRule(d.message, policy);
  if (rule) {
    if (rule.action === "suppress") return { classification: "suppressed", reason: `suppress rule "${rule.pattern}"` };
    return { classification: "known_fix", reason: `wired rule "${rule.pattern}"` };
  }
  return { classification: "unknown_actionable", reason: "unhandled agent-task failure" };
}

/**
 * #1708: typed anomaly gate. Anomalies never run line-fix matching or the
 * external-message regex: after the runtime mode and the source policy gate
 * pass, they reuse the existing project workflow as unknown_actionable.
 */
function classifyLogAnomaly(_event: LogAnomalyEvent, mode: SelfHealMode, policy: ShaPolicyView): ShaClassificationResult {
  const gate = policy.logAnomaly;
  if (!gate || !gate.shaAllowed) {
    return { classification: "suppressed", reason: "anomaly SHA admission disabled by policy" };
  }
  if (selfHealModeRank(mode) < selfHealModeRank(gate.minimumMode)) {
    return { classification: "suppressed", reason: `anomaly requires minimum mode ${gate.minimumMode}` };
  }
  return { classification: "unknown_actionable", reason: "typed log growth-rate anomaly" };
}

function classifyLog(event: LogFailureEvent, policy: ShaPolicyView): ShaClassificationResult {
  if (!policy.logAdmissionAllowed) {
    return { classification: "suppressed", reason: "malformed policy — log admission disabled until restart" };
  }
  if (RECURSION_TAGS.some((t) => event.tag.includes(t) || event.component.includes(t))) {
    return { classification: "suppressed", reason: `recursion tag "${event.tag}"` };
  }
  const rule = matchingRule(event.normalizedMessage, policy);
  if (rule) {
    if (rule.action === "suppress") return { classification: "suppressed", reason: `suppress rule "${rule.pattern}"` };
    return { classification: "known_fix", reason: `wired rule "${rule.pattern}"` };
  }
  if (EXTERNAL_LOG_RE.test(event.normalizedMessage)) {
    return { classification: "external", reason: "network/auth/external signature in record" };
  }
  if (event.normalizedMessage.length === 0 || event.normalizedMessage.length > 512) {
    return { classification: "ambiguous", reason: "empty or overlong normalized record" };
  }
  return { classification: "unknown_actionable", reason: "internal ERROR record" };
}

function matchingRule(message: string, policy: ShaPolicyView): FixRule | undefined {
  return policy.fixes.find((f) => f.pattern.length > 0 && message.includes(f.pattern));
}

/** Exhaustive classification set, for table-driven tests. */
export const CLASSIFICATIONS: readonly ShaClassification[] = [
  "suppressed",
  "known_fix",
  "unknown_actionable",
  "system",
  "credits",
  "external",
  "ambiguous",
];