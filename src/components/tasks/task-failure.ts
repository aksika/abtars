/**
 * task-failure.ts — #1520: structured scheduler failure diagnostics and the
 * single failure policy. Codes are stable machine data; messages are bounded
 * display data. Policy branches only on the structured fields, never on
 * message text.
 */
import type { TaskRunPhase } from "./task-state-store.js";

export type TaskFailureCategory =
  | "definition"
  | "routing"
  | "admission"
  | "dependency"
  | "execution"
  | "validation"
  | "interruption"
  | "delivery";

export type TaskFailureRetryability = "permanent" | "transient" | "none";

export interface TaskFailureDiagnosticV1 {
  version: 1;
  category: TaskFailureCategory;
  code: string;
  phase: TaskRunPhase | "delivery";
  message: string;
  retryability: TaskFailureRetryability;
  occurredAt: number;
}

const MAX_MESSAGE = 500;
const KNOWN_CODES: Readonly<Record<TaskFailureCategory, ReadonlySet<string>>> = {
  definition: new Set([
    "report_contract_missing",
    "artifact_path_invalid",
    "artifact_parent_unwritable",
    "required_file_missing",
    "required_file_unreadable",
    "required_executable_missing",
    "required_executable_not_executable",
    "required_tool_unregistered",
    "required_tool_dependency_unavailable",
    "invalid_definition",
    "state_repaired",
  ]),
  routing: new Set(["local_session_not_peer", "peer_not_enrolled", "target_unavailable"]),
  admission: new Set(["session_capacity", "type_busy", "model_cooldown", "executor_unavailable"]),
  dependency: new Set(["executable_missing", "probe_failed", "adapter_unavailable"]),
  execution: new Set(["process_exit", "model_error", "tool_error"]),
  validation: new Set([
    "artifact_not_found",
    "artifact_not_regular_file",
    "artifact_unreadable",
    "artifact_too_small",
    "required_heading_missing",
    "artifact_unchanged_baseline",
    "artifact_stale_mtime",
    "contract_mismatch",
  ]),
  interruption: new Set(["timed_out", "cancelled", "restart_interrupted", "deadline_exceeded"]),
  delivery: new Set(["definitely_not_sent", "send_unknown"]),
};

/** Safe constructor: bounds the message and rejects unknown category/code pairs. */
export function makeTaskFailure(
  category: TaskFailureCategory,
  code: string,
  phase: TaskRunPhase | "delivery",
  message: string,
  retryability: TaskFailureRetryability,
): TaskFailureDiagnosticV1 {
  const bounded = message.slice(0, MAX_MESSAGE);
  return {
    version: 1,
    category,
    code,
    phase,
    message: bounded,
    retryability,
    occurredAt: Date.now(),
  };
}

/** Parse a durable diagnostic; legacy string-only records are read, not parsed. */
export function parseTaskFailure(raw: unknown): TaskFailureDiagnosticV1 | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (d["version"] !== 1) return null;
  const category = d["category"];
  const code = d["code"];
  const phase = d["phase"];
  const retryability = d["retryability"];
  const occurredAt = d["occurredAt"];
  if (
    typeof category !== "string" ||
    typeof code !== "string" ||
    typeof phase !== "string" ||
    typeof retryability !== "string" ||
    typeof occurredAt !== "number"
  ) return null;
  if (!(category in KNOWN_CODES)) return null;
  if (!KNOWN_CODES[category as TaskFailureCategory].has(code)) return null;
  const validRetry = retryability === "permanent" || retryability === "transient" || retryability === "none";
  if (!validRetry) return null;
  const message = typeof d["message"] === "string" ? (d["message"] as string).slice(0, MAX_MESSAGE) : "";
  return {
    version: 1,
    category: category as TaskFailureCategory,
    code,
    phase: phase as TaskRunPhase | "delivery",
    message,
    retryability: retryability as TaskFailureRetryability,
    occurredAt,
  };
}

/** @deprecated for writes — legacy records carry free-form text. */
export function legacyFailureMessage(detail: string | undefined): string {
  return (detail ?? "").slice(0, MAX_MESSAGE);
}

export type FailurePolicyDecision =
  | { action: "defer" }
  | { action: "retry" }
  | { action: "count"; pauseNow: boolean }
  | { action: "clear" };

/**
 * Pure policy matrix (requirements §Failure contract). Inputs are structured
 * fields only; messages never influence the decision.
 *
 * - admission busy/cap/cooldown → defer the same occurrence (bounded deferral
 *   path), no failure increment.
 * - permanent definition/dependency/routing fault → no retry, count one failed
 *   group, auto-pause immediately.
 * - transient dependency/execution/validation fault → one delayed retry in the
 *   same run group; then count one failed group.
 * - non-transient execution/validation fault → no retry; count one failed group.
 * - timeout/restart interruption → no blind replay; count one failed group.
 * - operator cancellation → no retry and no failure increment.
 * - delivery states never call the scheduler settler; delivery is governed by
 *   its own bounded claim path (definitely_not_sent retries delivery only,
 *   unknown blocks automatic resend and exposes operator action).
 */
export function decideFailurePolicy(diagnostic: TaskFailureDiagnosticV1): FailurePolicyDecision {
  switch (diagnostic.category) {
    case "admission":
      return { action: "defer" };
    case "definition":
      return { action: "count", pauseNow: true };
    case "routing":
      return { action: "count", pauseNow: diagnostic.retryability === "permanent" };
    case "dependency":
      if (diagnostic.retryability === "transient") return { action: "retry" };
      return { action: "count", pauseNow: true };
    case "execution":
    case "validation":
      if (diagnostic.retryability === "transient") return { action: "retry" };
      return { action: "count", pauseNow: false };
    case "interruption":
      if (diagnostic.code === "cancelled") return { action: "clear" };
      return { action: "count", pauseNow: false };
    case "delivery":
      return { action: "clear" };
  }
}

/** Present one diagnostic as a compact operator string: category/code + safe message. */
export function formatTaskFailure(d: TaskFailureDiagnosticV1): string {
  return `${d.category}/${d.code}: ${d.message}`;
}
