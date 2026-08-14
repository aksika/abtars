import { createHash } from "node:crypto";
import { redactSecrets } from "../logger.js";
import type { BehaviorIncidentType } from "./pi-core-safety.js";

const PREVIEW_CAP = 160;
const STDERR_CAP = 500;
const STDOUT_CAP = 240;
const DIAGNOSTIC_CAP = 1200;

export type ToolFailureReason =
  | "nonzero_exit"
  | "spawn_error"
  | "timeout"
  | "aborted"
  | "policy_rejected"
  | "shell_syntax_error"
  | "repeated_failure"
  | "candidate_round_limit"
  | "prompt_round_limit"
  | "candidate_exhausted"
  // #1659: structured memory mutation failures (never collapsed to `unknown`).
  | "memory_validation"
  | "memory_not_found"
  | "memory_conflict"
  | "memory_unauthorized"
  | "memory_idempotency_conflict"
  | "memory_unavailable"
  | "memory_outcome_unknown"
  | "unknown";

const MEMORY_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "memory_validation", "memory_not_found", "memory_conflict",
  "memory_unauthorized", "memory_idempotency_conflict",
  "memory_unavailable", "memory_outcome_unknown",
]);

export interface ToolFailureDiagnosticV1 {
  version: 1;
  execution_id: string;
  tool: string;
  reason: ToolFailureReason;
  command_fingerprint?: string;
  command_preview?: string;
  exit_code?: number;
  process_error_code?: string;
  signal?: string;
  timed_out: boolean;
  aborted: boolean;
  stderr_excerpt?: string;
  stdout_excerpt?: string;
  safety_incident?: BehaviorIncidentType;
  candidate_exhausted?: boolean;
  /** #1595: structured bash syntax error — never auto-corrected, model must re-submit. */
  syntax_hint?: string;
  /** #1659: bounded structural memory failure metadata, redacted. */
  memory_failure?: {
    code: string;
    request_id: string;
    retryable: boolean;
    action: string;
    stage: string;
  };
  /** #1595: a prior tool failure retained only as supporting context when a terminal cause leads. */
  last_tool_failure?: {
    tool: string;
    reason: ToolFailureReason;
    command_preview?: string;
    exit_code?: number;
    stderr_excerpt?: string;
  };
}

export interface BashResultV1 {
  stdout?: string;
  stderr?: string;
  exit_code: number | null;
  process_error_code?: string;
  signal?: string;
  timed_out: boolean;
  aborted: boolean;
  command_fingerprint: string;
  command_preview: string;
}

export class PiCoreToolExecutionError extends Error {
  readonly diagnostic: ToolFailureDiagnosticV1;

  constructor(diagnostic: ToolFailureDiagnosticV1) {
    super(renderDiagnostic(diagnostic));
    this.diagnostic = diagnostic;
    this.name = "PiCoreToolExecutionError";
  }
}

function truncateTo(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, Math.max(max - 3, 0)) + "...";
}

function capAndRedact(text: string, cap: number): string {
  const redacted = redactSecrets(text);
  return truncateTo(redacted, cap);
}

export function fingerprintCommand(cmd: string): string {
  const hash = createHash("sha256").update(cmd).digest("hex");
  return hash.slice(0, 16);
}

export function previewCommand(cmd: string): string {
  const redacted = redactSecrets(cmd);
  const preview = redacted.replace(/\s+/g, " ").trim();
  return truncateTo(preview, PREVIEW_CAP);
}

export function parseBashResultToDiagnostic(
  result: string,
  executionId: string,
  tool: string,
): ToolFailureDiagnosticV1 | null {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const exitCode = typeof parsed.exit_code === "number" ? parsed.exit_code
      : parsed.exit_code === null ? null
      : undefined;

    const timedOut = parsed.timed_out === true;
    const aborted = parsed.aborted === true;
    const signal = typeof parsed.signal === "string" ? parsed.signal : undefined;
    const processErrorCode = typeof parsed.process_error_code === "string" ? parsed.process_error_code : undefined;
    const fp = typeof parsed.command_fingerprint === "string" && /^[0-9a-f]{16}$/i.test(parsed.command_fingerprint)
      ? parsed.command_fingerprint : undefined;
    const preview = typeof parsed.command_preview === "string" ? capAndRedact(parsed.command_preview, PREVIEW_CAP) : undefined;
    const hasError = parsed.error != null;

    const hasBashFields = "exit_code" in parsed || "timed_out" in parsed || "process_error_code" in parsed;

    if (!hasBashFields) return null;

    const isPolicyRejected = parsed.error === "policy_rejected";
    const isShellSyntaxError = parsed.error === "shell_syntax_error";

    let reason: ToolFailureReason = "nonzero_exit";
    if (timedOut) reason = "timeout";
    else if (aborted) reason = "aborted";
    else if (processErrorCode) reason = "spawn_error";
    else if (isPolicyRejected) reason = "policy_rejected";
    else if (isShellSyntaxError) reason = "shell_syntax_error";
    else if (exitCode === 0 || exitCode === null) {
      if (hasError) reason = "unknown";
      else return null;
    }

    if (exitCode === 0 && !hasError && !timedOut && !aborted && !processErrorCode) return null;

    const stderr = typeof parsed.stderr === "string" ? capAndRedact(parsed.stderr, STDERR_CAP) : undefined;
    const stdout = typeof parsed.stdout === "string" ? capAndRedact(parsed.stdout, STDOUT_CAP) : undefined;
    const syntaxHint = typeof parsed.syntax_hint === "string" ? capAndRedact(parsed.syntax_hint, PREVIEW_CAP) : undefined;

    return {
      version: 1,
      execution_id: executionId,
      tool,
      reason,
      command_fingerprint: fp,
      command_preview: preview,
      exit_code: exitCode ?? undefined,
      process_error_code: processErrorCode,
      signal,
      timed_out: timedOut,
      aborted,
      stderr_excerpt: stderr,
      stdout_excerpt: stdout,
      ...(syntaxHint ? { syntax_hint: syntaxHint } : {}),
    };
  } catch {
    return null;
  }
}

export function parseToolResultToDiagnostic(
  result: string,
  executionId: string,
  tool: string,
): ToolFailureDiagnosticV1 | null {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const hasBashFields = "exit_code" in parsed || "timed_out" in parsed || "command_fingerprint" in parsed;
    if (hasBashFields) {
      return parseBashResultToDiagnostic(result, executionId, tool);
    }
    // #1659: a structured memory failure maps by its bridge code — never
    // fall back to `unknown` when a known code exists.
    const code = typeof parsed.code === "string" ? parsed.code : "";
    if (MEMORY_FAILURE_REASONS.has(code)) {
      const memoryFailure: ToolFailureDiagnosticV1["memory_failure"] = {
        code,
        request_id: typeof parsed.requestId === "string" ? capAndRedact(parsed.requestId, 64) : "",
        retryable: parsed.retryable === true,
        action: typeof parsed.action === "string" ? capAndRedact(parsed.action, 32) : "",
        stage: typeof parsed.stage === "string" ? capAndRedact(parsed.stage, 32) : "",
      };
      return {
        version: 1,
        execution_id: executionId,
        tool,
        reason: code as ToolFailureReason,
        timed_out: false,
        aborted: false,
        stderr_excerpt: typeof parsed.message === "string" ? capAndRedact(parsed.message, STDERR_CAP) : undefined,
        memory_failure: memoryFailure,
      };
    }
    if (parsed.error != null) {
      return {
        version: 1,
        execution_id: executionId,
        tool,
        reason: "unknown",
        timed_out: false,
        aborted: false,
        stderr_excerpt: capAndRedact(String(parsed.error), STDERR_CAP),
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function buildUnknownDiagnostic(
  executionId: string,
  tool: string,
  errorMessage?: string,
): ToolFailureDiagnosticV1 {
  return {
    version: 1,
    execution_id: executionId,
    tool,
    reason: "unknown",
    timed_out: false,
    aborted: false,
    stderr_excerpt: errorMessage ? capAndRedact(errorMessage, STDERR_CAP) : undefined,
    // command_preview intentionally omitted for unknown/exceptions —
    // never place untrusted error text into the command field (#1497 review).
  };
}

export function mergeSafetyIncident(
  diagnostic: ToolFailureDiagnosticV1,
  incidentType?: string,
  candidateExhausted?: boolean,
): ToolFailureDiagnosticV1 {
  let reason = diagnostic.reason;
  if (incidentType) {
    if (incidentType === "repeated_failure") reason = "repeated_failure";
    else if (incidentType === "candidate_round_limit") reason = "candidate_exhausted";
    else if (incidentType === "prompt_round_limit") reason = "prompt_round_limit";
  }
  return {
    ...diagnostic,
    reason,
    safety_incident: incidentType as ToolFailureDiagnosticV1["safety_incident"],
    candidate_exhausted: candidateExhausted ?? diagnostic.candidate_exhausted,
  };
}

/** Build a structured failure when Pi stopped before a tool produced a diagnostic. */
export function buildSafetyDiagnostic(
  executionId: string,
  incident: { type: BehaviorIncidentType; toolName?: string },
): ToolFailureDiagnosticV1 {
  const reason = incident.type === "candidate_round_limit"
    ? "candidate_round_limit"
    : incident.type === "prompt_round_limit"
      ? "prompt_round_limit"
      : "unknown";
  return {
    version: 1,
    execution_id: executionId,
    tool: incident.toolName ?? "pi-safety",
    reason,
    timed_out: false,
    aborted: false,
    safety_incident: incident.type,
    candidate_exhausted: incident.type === "candidate_round_limit",
  };
}

/** #1595: compact supporting-context summary of a prior tool failure. */
export function summarizeToolFailure(d: ToolFailureDiagnosticV1): NonNullable<ToolFailureDiagnosticV1["last_tool_failure"]> {
  return {
    tool: d.tool,
    reason: d.reason,
    ...(d.command_preview ? { command_preview: capAndRedact(d.command_preview, PREVIEW_CAP) } : {}),
    ...(d.exit_code != null ? { exit_code: d.exit_code } : {}),
    ...(d.stderr_excerpt ? { stderr_excerpt: capAndRedact(d.stderr_excerpt, STDERR_CAP) } : {}),
  };
}

/**
 * #1595: assemble the final diagnostic when a run ended empty after a safety
 * termination. The terminal cause ALWAYS leads; a prior tool failure is
 * supporting context only (`last_tool_failure`), and candidate_exhausted is
 * never reported unless the terminal incident actually is candidate_round_limit
 * (a run that continued past rotation must not claim exhaustion).
 */
export function buildTerminalDiagnostic(
  executionId: string,
  incident: { type: BehaviorIncidentType },
  lastToolFailure?: ToolFailureDiagnosticV1,
): ToolFailureDiagnosticV1 {
  const base = buildSafetyDiagnostic(executionId, incident);
  if (!lastToolFailure) return base;
  return { ...base, last_tool_failure: summarizeToolFailure(lastToolFailure) };
}

export function renderDiagnostic(d: ToolFailureDiagnosticV1): string {
  const parts: string[] = [`Tool ${d.tool} failed`];

  if (d.execution_id) parts.push(`eid:${d.execution_id}`);
  if (d.command_preview) parts.push(`cmd: ${d.command_preview}`);
  if (d.command_fingerprint) parts.push(`fp:${d.command_fingerprint}`);

  if (d.reason === "timeout") {
    parts.push("reason: timeout");
  } else if (d.reason === "aborted") {
    parts.push("reason: aborted");
  } else if (d.reason === "spawn_error") {
    parts.push(`reason: spawn_error${d.process_error_code ? ` (${d.process_error_code})` : ""}`);
  } else if (d.reason === "policy_rejected") {
    parts.push("reason: blocklisted by policy");
  } else if (d.reason === "shell_syntax_error") {
    parts.push("reason: shell syntax error");
  } else if (d.reason === "repeated_failure") {
    parts.push("reason: 3 consecutive failures");
  } else if (d.reason === "candidate_exhausted") {
    parts.push("reason: no eligible candidate");
  } else if (d.reason === "candidate_round_limit") {
    parts.push("reason: candidate round limit");
  } else if (d.reason === "prompt_round_limit") {
    parts.push("reason: prompt round limit");
  } else if (MEMORY_FAILURE_REASONS.has(d.reason)) {
    parts.push(`reason: ${d.reason}`);
  } else if (d.reason === "unknown") {
    parts.push("reason: unknown error");
  }

  if (d.syntax_hint) parts.push(`syntax: ${d.syntax_hint}`);
  if (d.exit_code != null && d.exit_code !== 0) parts.push(`exit:${d.exit_code}`);
  if (d.signal) parts.push(`signal:${d.signal}`);

  if (d.memory_failure) {
    const mf = d.memory_failure;
    parts.push(`memory: code=${mf.code} requestId=${mf.request_id} retryable=${mf.retryable} action=${mf.action} stage=${mf.stage}`);
  }

  if (d.stderr_excerpt) parts.push(`stderr: ${d.stderr_excerpt}`);
  if (d.stdout_excerpt) parts.push(`stdout: ${d.stdout_excerpt}`);

  if (d.safety_incident) parts.push(`incident:${d.safety_incident}`);
  if (d.candidate_exhausted) parts.push("candidate_exhausted:true");
  if (d.last_tool_failure) {
    const prior = d.last_tool_failure;
    const priorParts = [`tool:${prior.tool}`, `reason:${prior.reason}`];
    if (prior.command_preview) priorParts.push(`cmd:${prior.command_preview}`);
    if (prior.exit_code != null) priorParts.push(`exit:${prior.exit_code}`);
    if (prior.stderr_excerpt) priorParts.push(`stderr:${prior.stderr_excerpt}`);
    parts.push(`last tool failure (context): ${priorParts.join(" ")}`);
  }

  const rendered = parts.join(" | ");
  return truncateTo(rendered, DIAGNOSTIC_CAP);
}
