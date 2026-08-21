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
import { redactSecrets } from "../logger.js";
import type { FixRule } from "./sha-policy.js";
import type {
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

const RECURSION_TAGS: readonly string[] = ["self-healer", "self_healer", "sha-", "watchdog"];

const EXTERNAL_LOG_RE = /(network|connection refused|connection reset|econnrefused|econnreset|enotfound|etimedout|socket hang|unauthorized|authentication failed|tls|ssl|dns|proxy|timeout)/i;

export interface ShaPolicyView {
  readonly fixes: readonly FixRule[];
  readonly logAdmissionAllowed: boolean;
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

/** #1688 R3: structured external/authorization outage — never message text. */
function isExternalScheduled(d: TaskFailureDiagnosticV1): boolean {
  if (d.category === "routing") return true;
  if (d.category === "dependency" && (d.code === "adapter_unavailable" || d.code === "probe_failed")) return true;
  return false;
}

/** Pure exhaustive classification. Never reads env, store, or platform state. */
export function classifyShaFailure(
  signal: ScheduledFailureEvent | LogFailureEvent,
  mode: SelfHealMode,
  policy: ShaPolicyView,
): ShaClassificationResult {
  if (mode === "off") return { classification: "suppressed", reason: "mode off" };
  if (signal.source === "scheduled") return classifyScheduled(signal, policy);
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