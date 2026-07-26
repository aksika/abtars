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
  | "repeated_failure"
  | "candidate_exhausted"
  | "unknown";

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
    const fp = typeof parsed.command_fingerprint === "string" ? parsed.command_fingerprint : undefined;
    const preview = typeof parsed.command_preview === "string" ? capAndRedact(parsed.command_preview, PREVIEW_CAP) : undefined;
    const hasError = parsed.error != null;

    const hasBashFields = "exit_code" in parsed || "timed_out" in parsed || "process_error_code" in parsed;

    if (!hasBashFields) return null;

    let reason: ToolFailureReason = "nonzero_exit";
    if (timedOut) reason = "timeout";
    else if (aborted) reason = "aborted";
    else if (processErrorCode) reason = "spawn_error";
    else if (exitCode === 126) reason = "policy_rejected";
    else if (exitCode === 0 || exitCode === null) {
      if (hasError) reason = "unknown";
      else return null;
    }

    if (exitCode === 0 && !hasError && !timedOut && !aborted && !processErrorCode) return null;

    const stderr = typeof parsed.stderr === "string" ? capAndRedact(parsed.stderr, STDERR_CAP) : undefined;
    const stdout = typeof parsed.stdout === "string" ? capAndRedact(parsed.stdout, STDOUT_CAP) : undefined;

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
    command_preview: errorMessage ? capAndRedact(errorMessage, PREVIEW_CAP) : undefined,
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
  }
  return {
    ...diagnostic,
    reason,
    safety_incident: incidentType as ToolFailureDiagnosticV1["safety_incident"],
    candidate_exhausted: candidateExhausted ?? diagnostic.candidate_exhausted,
  };
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
  } else if (d.reason === "repeated_failure") {
    parts.push("reason: 3 consecutive failures");
  } else if (d.reason === "candidate_exhausted") {
    parts.push("reason: no eligible candidate");
  } else if (d.reason === "unknown") {
    parts.push("reason: unknown error");
  }

  if (d.exit_code != null && d.exit_code !== 0) parts.push(`exit:${d.exit_code}`);
  if (d.signal) parts.push(`signal:${d.signal}`);

  if (d.stderr_excerpt) parts.push(`stderr: ${d.stderr_excerpt}`);
  if (d.stdout_excerpt) parts.push(`stdout: ${d.stdout_excerpt}`);

  if (d.safety_incident) parts.push(`incident:${d.safety_incident}`);
  if (d.candidate_exhausted) parts.push("candidate_exhausted:true");

  const rendered = parts.join(" | ");
  return truncateTo(rendered, DIAGNOSTIC_CAP);
}
