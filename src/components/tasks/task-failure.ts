/**
 * task-failure.ts — #1520: structured scheduler failure diagnostics and the
 * single failure policy. Codes are stable machine data; messages are bounded
 * display data. Policy branches only on the structured fields, never on
 * message text.
 */
import type { TaskRunPhase } from "./task-state-store.js";
import { redactSecrets } from "../logger.js";

export type TaskFailureCategory =
  | "definition"
  | "routing"
  | "admission"
  | "dependency"
  | "execution"
  | "validation"
  | "interruption"
  | "delivery"
  | "supervision";

export type TaskFailureRetryability = "permanent" | "transient" | "none";

/** #1609: counted failed run groups before a scheduled task auto-pauses. */
export const AUTO_PAUSE_FAILURE_THRESHOLD = 5;
/** #1609: automatic resume cooldown after any pause (epoch ms). */
export const AUTO_RESUME_COOLDOWN_MS = 12 * 60 * 60 * 1000;
/** #1609: at most this many automatic resumes in one uninterrupted failure episode. */
export const MAX_AUTO_RESUMES_PER_EPISODE = 3;
/** #1609: paused-task WARN ceiling per task per rolling hour. */
export const PAUSED_WARN_LIMIT_PER_HOUR = 12;
/** #1609: minimum admitted interval between paused-task WARN records. */
export const PAUSED_WARN_INTERVAL_MS = (60 * 60 * 1000) / PAUSED_WARN_LIMIT_PER_HOUR;

export interface TaskFailureLaneFact {
  readonly cardId: number;
  readonly contractId: string;
  readonly attemptId: string;
  readonly lifecycle: string;
  readonly cancelReason?: string;
  readonly hardDeadlineAt?: string;
  readonly settledAt?: string;
  readonly overrunMs?: number;
  readonly bindingLimit?: { readonly name: string; readonly value: number };
  readonly criteria: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  readonly missingEvidence: ReadonlyArray<string>;
}

export interface TaskFailureContextV1 {
  readonly rootCardId?: number;
  readonly lanes: ReadonlyArray<TaskFailureLaneFact>;
  readonly remediationHint?: string;
}

export interface TaskFailureDiagnosticV1 {
  version: 1;
  category: TaskFailureCategory;
  code: string;
  phase: TaskRunPhase | "delivery";
  message: string;
  retryability: TaskFailureRetryability;
  occurredAt: number;
  context?: TaskFailureContextV1;
}

const MAX_MESSAGE = 500;
const MAX_CONTEXT_LANES = 8;
const MAX_CONTEXT_CRITERIA = 20;
const MAX_REMEDIATION_HINT = 300;
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
  execution: new Set(["process_exit", "model_error", "tool_error", "credits_exhausted"]),
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
  interruption: new Set(["timed_out", "cancelled", "restart_interrupted", "deadline_exceeded", "owner_lost"]),
  delivery: new Set(["definitely_not_sent", "send_unknown"]),
  supervision: new Set([
    "lane_timed_out",
    "lane_late_completion",
    "lane_failed",
    "criterion_unevidenced",
    "contract_uncovered",
    "project_blocked",
  ]),
};

/** Safe constructor: bounds the message and rejects unknown category/code pairs. */
export function makeTaskFailure(
  category: TaskFailureCategory,
  code: string,
  phase: TaskRunPhase | "delivery",
  message: string,
  retryability: TaskFailureRetryability,
  context?: TaskFailureContextV1,
): TaskFailureDiagnosticV1 {
  if (!KNOWN_CODES[category]?.has(code)) {
    throw new Error(`Unknown task failure code: ${category}/${code}`);
  }
  const bounded = redactSecrets(message).slice(0, MAX_MESSAGE);
  return {
    version: 1,
    category,
    code,
    phase,
    message: bounded,
    retryability,
    occurredAt: Date.now(),
    ...(context !== undefined ? { context: sanitizeContext(context) } : {}),
  };
}

function sanitizeContext(ctx: TaskFailureContextV1): TaskFailureContextV1 {
  const lanes: TaskFailureLaneFact[] = ctx.lanes.slice(0, MAX_CONTEXT_LANES).map((lane) => {
    const criteria = lane.criteria.slice(0, MAX_CONTEXT_CRITERIA).map((c) => ({
      id: redactSecrets(c.id).slice(0, 200),
      status: redactSecrets(c.status).slice(0, 50),
    }));
    return {
      cardId: lane.cardId,
      contractId: redactSecrets(lane.contractId).slice(0, 200),
      attemptId: redactSecrets(lane.attemptId).slice(0, 200),
      lifecycle: redactSecrets(lane.lifecycle).slice(0, 50),
      ...(lane.cancelReason !== undefined ? { cancelReason: redactSecrets(lane.cancelReason).slice(0, 500) } : {}),
      ...(lane.hardDeadlineAt !== undefined ? { hardDeadlineAt: redactSecrets(lane.hardDeadlineAt).slice(0, 64) } : {}),
      ...(lane.settledAt !== undefined ? { settledAt: redactSecrets(lane.settledAt).slice(0, 64) } : {}),
      ...(lane.overrunMs !== undefined && Number.isFinite(lane.overrunMs) ? { overrunMs: lane.overrunMs } : {}),
      ...(lane.bindingLimit !== undefined ? {
        bindingLimit: {
          name: redactSecrets(lane.bindingLimit.name).slice(0, 100),
          value: lane.bindingLimit.value,
        },
      } : {}),
      criteria,
      missingEvidence: lane.missingEvidence.slice(0, MAX_CONTEXT_CRITERIA).map((id) => redactSecrets(id).slice(0, 200)),
    };
  });
  return {
    ...(ctx.rootCardId !== undefined ? { rootCardId: ctx.rootCardId } : {}),
    lanes,
    ...(ctx.remediationHint !== undefined ? { remediationHint: redactSecrets(ctx.remediationHint).slice(0, MAX_REMEDIATION_HINT) } : {}),
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
  const message = typeof d["message"] === "string"
    ? redactSecrets(d["message"] as string).slice(0, MAX_MESSAGE)
    : "";
  let context: TaskFailureContextV1 | undefined;
  if (d["context"] !== undefined) {
    context = parseContext(d["context"]);
  }
  return {
    version: 1,
    category: category as TaskFailureCategory,
    code,
    phase: phase as TaskRunPhase | "delivery",
    message,
    retryability: retryability as TaskFailureRetryability,
    occurredAt,
    ...(context !== undefined ? { context } : {}),
  };
}

/** Validate a durable context block; a malformed context is dropped whole. */
function parseContext(raw: unknown): TaskFailureContextV1 | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c["lanes"])) return undefined;
  if (c["rootCardId"] !== undefined && (typeof c["rootCardId"] !== "number" || !Number.isFinite(c["rootCardId"]))) return undefined;
  if (c["remediationHint"] !== undefined && typeof c["remediationHint"] !== "string") return undefined;
  const lanes: TaskFailureLaneFact[] = [];
  for (const rawLane of c["lanes"] as unknown[]) {
    if (typeof rawLane !== "object" || rawLane === null) return undefined;
    const l = rawLane as Record<string, unknown>;
    if (
      typeof l["cardId"] !== "number" ||
      !Number.isFinite(l["cardId"] as number) ||
      typeof l["contractId"] !== "string" ||
      typeof l["attemptId"] !== "string" ||
      typeof l["lifecycle"] !== "string" ||
      !Array.isArray(l["criteria"]) ||
      !Array.isArray(l["missingEvidence"])
    ) return undefined;
    const criteria: Array<{ id: string; status: string }> = [];
    for (const rawC of l["criteria"] as unknown[]) {
      if (typeof rawC !== "object" || rawC === null) return undefined;
      const co = rawC as Record<string, unknown>;
      if (typeof co["id"] !== "string" || typeof co["status"] !== "string") return undefined;
      criteria.push({ id: co["id"], status: co["status"] });
    }
    const missingEvidenceValues = (l["missingEvidence"] as unknown[]).map((value) => {
      if (typeof value !== "string") return undefined;
      return value;
    });
    if (missingEvidenceValues.some((value) => value === undefined)) return undefined;
    const missingEvidence = missingEvidenceValues as string[];
    let bindingLimit: { readonly name: string; readonly value: number } | undefined;
    if (l["bindingLimit"] !== undefined) {
      if (typeof l["bindingLimit"] !== "object" || l["bindingLimit"] === null) return undefined;
      const bl = l["bindingLimit"] as Record<string, unknown>;
      if (typeof bl["name"] !== "string" || typeof bl["value"] !== "number" || !Number.isFinite(bl["value"])) return undefined;
      bindingLimit = { name: bl["name"], value: bl["value"] };
    }
    if (l["cancelReason"] !== undefined && typeof l["cancelReason"] !== "string") return undefined;
    if (l["hardDeadlineAt"] !== undefined && typeof l["hardDeadlineAt"] !== "string") return undefined;
    if (l["settledAt"] !== undefined && typeof l["settledAt"] !== "string") return undefined;
    if (l["overrunMs"] !== undefined && (typeof l["overrunMs"] !== "number" || !Number.isFinite(l["overrunMs"]))) return undefined;
    lanes.push({
      cardId: l["cardId"],
      contractId: l["contractId"],
      attemptId: l["attemptId"],
      lifecycle: l["lifecycle"],
      ...(l["cancelReason"] !== undefined ? { cancelReason: l["cancelReason"] } : {}),
      ...(l["hardDeadlineAt"] !== undefined ? { hardDeadlineAt: l["hardDeadlineAt"] } : {}),
      ...(l["settledAt"] !== undefined ? { settledAt: l["settledAt"] } : {}),
      ...(l["overrunMs"] !== undefined ? { overrunMs: l["overrunMs"] } : {}),
      ...(bindingLimit !== undefined ? { bindingLimit } : {}),
      criteria,
      missingEvidence,
    });
  }
  if (lanes.length === 0) return undefined;
  return sanitizeContext({
    ...(c["rootCardId"] !== undefined ? { rootCardId: c["rootCardId"] } : {}),
    lanes,
    ...(c["remediationHint"] !== undefined ? { remediationHint: c["remediationHint"] } : {}),
  });
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
      // #1609: a dependency fault is a transient availability signal — even a
      // non-transient one counts toward the threshold instead of pausing
      // immediately. The existing transient retry is retained unchanged.
      if (diagnostic.retryability === "transient") return { action: "retry" };
      return { action: "count", pauseNow: false };
    case "execution":
    case "validation":
      if (diagnostic.retryability === "transient") return { action: "retry" };
      return { action: "count", pauseNow: false };
    case "interruption":
      if (diagnostic.code === "cancelled") return { action: "clear" };
      return { action: "count", pauseNow: false };
    case "delivery":
      return { action: "clear" };
    case "supervision":
      // Only an unevidenceable/uncovered contract is a definition-shaped fault
      // worth pausing on; lane outcomes are counted, not blindly replayed.
      if (diagnostic.code === "criterion_unevidenced" || diagnostic.code === "contract_uncovered") {
        return { action: "count", pauseNow: true };
      }
      return { action: "count", pauseNow: false };
  }
}

/** Present one diagnostic as a compact operator string: category/code + safe message. */
export function formatTaskFailure(d: TaskFailureDiagnosticV1): string {
  return `${d.category}/${d.code}: ${d.message}`;
}

/** Multi-line lane breakdown for the operator notification and the SHA prompt. */
export function formatTaskFailureDetail(d: TaskFailureDiagnosticV1): string {
  const ctx = d.context;
  if (!ctx) return formatTaskFailure(d);
  const lines: string[] = [`${d.category}/${d.code}: ${d.message}`];
  for (const lane of ctx.lanes) {
    const parts = [
      `card ${lane.cardId}`,
      `contract ${lane.contractId}`,
      `lifecycle ${lane.lifecycle}`,
    ];
    if (lane.cancelReason) parts.push(`cancel_reason "${lane.cancelReason}"`);
    if (lane.hardDeadlineAt) parts.push(`hard_deadline ${lane.hardDeadlineAt}`);
    if (lane.settledAt) parts.push(`settled ${lane.settledAt}`);
    if (lane.overrunMs !== undefined) parts.push(`overrun_ms ${lane.overrunMs}`);
    if (lane.bindingLimit) parts.push(`binding_limit ${lane.bindingLimit.name}=${lane.bindingLimit.value}`);
    lines.push(`Lane: ${parts.join(", ")}`);
    if (lane.criteria.length > 0) {
      lines.push(`Criteria: ${lane.criteria.map((c) => `${c.id}=${c.status}`).join(", ")}`);
    }
    if (lane.missingEvidence.length > 0) {
      lines.push(`Unevidenced criteria: ${lane.missingEvidence.join(", ")}`);
    }
  }
  if (ctx.remediationHint) lines.push(`Remediation: ${ctx.remediationHint}`);
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** #1588: structured <root-cause> block for the self-healer prompt. */
export function formatTaskFailureRootCause(d: TaskFailureDiagnosticV1): string {
  const lines: string[] = ["<root-cause>"];
  const ctx = d.context;
  if (!ctx) {
    lines.push(`  <failure code="${escapeXml(d.category)}/${escapeXml(d.code)}" message="${escapeXml(d.message)}"/>`);
  } else {
    if (ctx.rootCardId !== undefined) lines.push(`  <root card="${ctx.rootCardId}"/>`);
    for (const lane of ctx.lanes) {
      const attrs = [
        `card="${lane.cardId}"`,
        `contract="${escapeXml(lane.contractId)}"`,
        `lifecycle="${escapeXml(lane.lifecycle)}"`,
      ];
      if (lane.cancelReason) attrs.push(`cancel-reason="${escapeXml(lane.cancelReason)}"`);
      if (lane.hardDeadlineAt) attrs.push(`hard-deadline="${escapeXml(lane.hardDeadlineAt)}"`);
      if (lane.settledAt) attrs.push(`settled="${escapeXml(lane.settledAt)}"`);
      if (lane.overrunMs !== undefined) attrs.push(`overrun-ms="${lane.overrunMs}"`);
      if (lane.bindingLimit) attrs.push(`binding-limit="${escapeXml(lane.bindingLimit.name)}=${lane.bindingLimit.value}"`);
      lines.push(`  <lane ${attrs.join(" ")}>`);
      for (const c of lane.criteria) {
        const evidence = lane.missingEvidence.includes(c.id) ? "none" : "present";
        lines.push(`    <criterion id="${escapeXml(c.id)}" status="${escapeXml(c.status)}" evidence="${evidence}"/>`);
      }
      lines.push("  </lane>");
    }
  }
  lines.push("</root-cause>");
  return lines.join("\n");
}
