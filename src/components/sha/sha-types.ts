/**
 * sha-types.ts — shared SHA (self-healing architecture) vocabulary for the
 * staged incident workflow (#1688).
 *
 * Type-only module: no runtime dependencies on tasks, stores, or platforms.
 * The classifier (sha-classifier.ts) and coordinator (sha-incident-coordinator.ts)
 * build on these contracts without importing Telegram, Pi, or Kanban internals.
 */
import type { TaskKind } from "../tasks/task-types.js";
import type { TaskFailureDiagnosticV1 } from "../tasks/task-failure.js";

export type SelfHealMode = "off" | "investigation" | "full";

export const SELF_HEAL_MODES: readonly SelfHealMode[] = ["off", "investigation", "full"];

/**
 * Parse SELFHEAL_MODE input. Missing defaults to "off"; any invalid value
 * behaves as "off" and reports `warned` so the caller can log one warning.
 */
export function parseSelfHealMode(raw: string | undefined): { mode: SelfHealMode; warned: boolean } {
  if (raw === "investigation" || raw === "full") return { mode: raw, warned: false };
  return { mode: "off", warned: raw !== undefined && raw !== "off" };
}

/** #1688 R2: typed, exactly-once scheduled failure signal. */
export interface ScheduledFailureEvent {
  readonly source: "scheduled";
  readonly entryId: string;
  readonly runId: string;
  readonly taskKind: TaskKind;
  readonly cardId?: number;
  readonly diagnostic: TaskFailureDiagnosticV1;
  readonly occurredAt: number;
}

/** #1688 R2: typed log-scanner failure signal (component/tag + cursor identity). */
export interface LogFailureEvent {
  readonly source: "log";
  readonly component: string;
  readonly tag: string;
  /** Canonical log file identity. */
  readonly logPath: string;
  readonly inode: number;
  /** Line-start byte offset in the file at the time the record was read. */
  readonly lineOffset: number;
  /** Normalized, redacted, bounded message. */
  readonly normalizedMessage: string;
  readonly occurredAt: number;
  /** Bounded redacted evidence (≤ 2 KiB). */
  readonly evidence: string;
}

/**
 * #1708: typed episode-level log growth-rate anomaly produced by the #1709
 * detector. The producer is an untrusted internal boundary — the coordinator
 * re-validates, re-redacts, and byte-bounds everything before persistence.
 * One detector episode emits one stable identity; repeated samples reuse the
 * event key and are duplicates, not new admissions.
 */
export interface LogAnomalyEvent {
  readonly source: "logAnomaly";
  readonly schemaVersion: 1;
  readonly anomalyKind: "growth_rate";
  /** Absolute, normalized active-log path (≤ 1024 UTF-8 bytes). */
  readonly logPath: string;
  /** Non-negative safe integer; physical identity only. */
  readonly inode: number;
  /** Unix-epoch milliseconds; episodeStartedAt <= windowStartedAt < windowEndedAt. */
  readonly episodeStartedAt: number;
  readonly windowStartedAt: number;
  readonly windowEndedAt: number;
  /** Safe integer >= 2. */
  readonly sampleCount: number;
  /** Finite bytes/minute > 0; observed >= baseline. */
  readonly baselineBytesPerMinute: number;
  readonly observedBytesPerMinute: number;
  /** Finite >= 1 and consistent with observed/baseline within relative 1e-6. */
  readonly ratio: number;
  /** Bounded redacted evidence (≤ 2048 UTF-8 bytes); never a raw-log dump. */
  readonly evidence: string;
}

export type ShaFailureSignal = ScheduledFailureEvent | LogFailureEvent | LogAnomalyEvent;

export type ShaClassification =
  | "suppressed"
  | "known_fix"
  | "unknown_actionable"
  | "system"
  | "credits"
  | "external"
  | "ambiguous";

export interface ShaClassificationResult {
  readonly classification: ShaClassification;
  readonly reason: string;
}

export type ShaAdmissionOutcome =
  | { kind: "ignored"; reason: "off" | "system" | "credits" | "external" | "ambiguous" | "suppressed" | "cooldown" }
  | { kind: "duplicate_event" }
  | { kind: "attached"; incidentId: number; rootCardId: number; occurrenceCount: number }
  | { kind: "project_created"; incidentId: number; rootCardId: number; mode: "investigation" | "full" }
  | { kind: "known_fix_started"; incidentId: number }
  | { kind: "known_fix_recommended" }
  | { kind: "blocked"; reason: string };

export type ShaIncidentState =
  | "provisioning"
  | "rca"
  | "design"
  | "solution"
  | "review"
  | "known_fix_running"
  | "known_fix_verified"
  | "known_fix_unverified"
  | "known_fix_failed"
  | "investigation_complete"
  | "accepted"
  | "blocked";

export function isTerminalShaIncidentState(state: ShaIncidentState): boolean {
  switch (state) {
    case "investigation_complete":
    case "accepted":
    case "blocked":
    case "known_fix_verified":
    case "known_fix_unverified":
    case "known_fix_failed":
      return true;
    case "provisioning":
    case "rca":
    case "design":
    case "solution":
    case "review":
    case "known_fix_running":
      return false;
  }
}

export function assertExhaustive(value: never): never {
  throw new Error(`unreachable SHA state: ${String(value)}`);
}