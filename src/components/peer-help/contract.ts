import { randomUUID } from "node:crypto";

export type HelpDecision = "accepted" | "declined" | "deferred";

export interface PeerHelpRequestV1 {
  version: 1;
  request_id: string;
  created_at: string;
  expires_at: string;
  goal: string;
  context?: string;
  priority?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  required_capabilities: string[];
  acceptance?: WorkerAcceptanceContractV1;
  target?:
    | { executor: "agent" }
    | {
        executor: "pi";
        workspace_alias: string;
        model?: {
          provider: string;
          model_id: string;
          thinking?: string;
        };
        delivery?: "commit_push" | "patch_artifact" | "leave_remote";
      };
}

export interface PeerHelpResponseV1 {
  version: 1;
  request_id: string;
  decision: HelpDecision;
  contribution_ref?: string;
  reason_code?: string;
  reason?: string;
  retry_after?: string;
}

export interface PeerHelpStatusRequestV1 {
  version: 1;
  request_id: string;
  contribution_ref: string;
}

export interface PeerHelpStatusV1 {
  version: 1;
  request_id: string;
  contribution_ref: string;
  state: "queued" | "running" | "awaiting_input" | "completed" | "failed" | "withdrawal_noted";
  updated_at: string;
  summary?: string;
}

export interface PeerHelpWithdrawV1 {
  version: 1;
  request_id: string;
  contribution_ref: string;
  reason?: string;
}

export type ContributionEventKind = "progress" | "completed" | "failed" | "withdrawal_noted";

export interface PeerContributionEventV1 {
  version: 1;
  event_id: string;
  sequence: number;
  request_id: string;
  contribution_ref: string;
  kind: ContributionEventKind;
  occurred_at: string;
  summary?: string;
  evidence?: WorkerResultEnvelopeV1;
  artifacts?: BoundedArtifactRef[];
}

export const HELP_WIRE_METHODS = [
  "help.request.v1",
  "help.status.v1",
  "help.withdraw.v1",
  "help.event.v1",
] as const;

export type HelpWireMethod = (typeof HELP_WIRE_METHODS)[number];

const MAX_GOAL_LENGTH = 100_000;
const MAX_CONTEXT_LENGTH = 50_000;
const MAX_CAPABILITIES = 50;
const MAX_CAPABILITY_LENGTH = 128;
const MAX_REASON_LENGTH = 2000;
const MAX_SUMMARY_LENGTH = 10_000;
const MAX_EVIDENCE_BYTES = 1_000_000;
const MAX_ARTIFACTS = 20;
const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_RE = /^[A-Za-z0-9._:\-]+$/;

export const HELP_DEFAULTS = {
  maxGoalLength: MAX_GOAL_LENGTH,
  maxContextLength: MAX_CONTEXT_LENGTH,
  maxCapabilities: MAX_CAPABILITIES,
  maxCapabilityLength: MAX_CAPABILITY_LENGTH,
  maxReasonLength: MAX_REASON_LENGTH,
  maxSummaryLength: MAX_SUMMARY_LENGTH,
  maxEvidenceBytes: MAX_EVIDENCE_BYTES,
  maxArtifacts: MAX_ARTIFACTS,
  maxRequestIdLength: MAX_REQUEST_ID_LENGTH,
} as const;

export interface WorkerAcceptanceContractV1 {
  max_turns?: number;
  max_tokens?: number;
  timeout_minutes?: number;
  require_approval?: boolean;
}

export interface WorkerResultEnvelopeV1 {
  summary: string;
  artifacts?: BoundedArtifactRef[];
  tokens_used?: number;
  metadata?: Record<string, unknown>;
}

export interface BoundedArtifactRef {
  name: string;
  content_type: string;
  size_bytes: number;
  ref: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isOptionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

function isISODate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v);
}

export function normalizeCapabilities(caps: unknown): string[] {
  if (!Array.isArray(caps)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of caps) {
    if (typeof c === "string" && c.length > 0 && c.length <= MAX_CAPABILITY_LENGTH) {
      const normal = c.trim().toLowerCase();
      if (!seen.has(normal)) {
        seen.add(normal);
        result.push(normal);
      }
    }
  }
  result.sort();
  return result.slice(0, MAX_CAPABILITIES);
}

export function validateRequestId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_REQUEST_ID_LENGTH && REQUEST_ID_RE.test(id);
}

export function parseHelpRequest(raw: unknown): { ok: true; value: PeerHelpRequestV1 } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "payload must be an object" };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { ok: false, error: "unsupported version" };
  if (!validateRequestId(r.request_id)) return { ok: false, error: "invalid request_id" };
  if (!isISODate(r.created_at)) return { ok: false, error: "invalid or missing created_at" };
  if (!isISODate(r.expires_at)) return { ok: false, error: "invalid or missing expires_at" };
  if (new Date(r.expires_at) < new Date(r.created_at)) return { ok: false, error: "expires_at must be after created_at" };
  if (!isNonEmptyString(r.goal)) return { ok: false, error: "invalid or missing goal" };
  if (r.goal.length > MAX_GOAL_LENGTH) return { ok: false, error: `goal exceeds ${MAX_GOAL_LENGTH} chars` };
  if (!isOptionalString(r.context)) return { ok: false, error: "context must be a string" };
  if (typeof r.context === "string" && r.context.length > MAX_CONTEXT_LENGTH) return { ok: false, error: `context exceeds ${MAX_CONTEXT_LENGTH} chars` };
  if (r.priority !== undefined && !["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(r.priority as string)) return { ok: false, error: "invalid priority" };
  if (r.required_capabilities !== undefined && !Array.isArray(r.required_capabilities)) return { ok: false, error: "required_capabilities must be an array" };
  const capabilities = normalizeCapabilities(r.required_capabilities);
  if (r.target !== undefined) {
    if (typeof r.target !== "object" || r.target === null) return { ok: false, error: "target must be an object" };
    const t = r.target as Record<string, unknown>;
    if (t.executor === "pi") {
      if (!isNonEmptyString(t.workspace_alias)) return { ok: false, error: "workspace_alias required for pi executor" };
    } else if (t.executor !== "agent") {
      return { ok: false, error: "target executor must be 'agent' or 'pi'" };
    }
  }
  return {
    ok: true,
    value: {
      version: 1,
      request_id: r.request_id as string,
      created_at: r.created_at as string,
      expires_at: r.expires_at as string,
      goal: r.goal as string,
      context: r.context as string | undefined,
      priority: r.priority as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | undefined,
      required_capabilities: capabilities,
      acceptance: r.acceptance as WorkerAcceptanceContractV1 | undefined,
      target: r.target as PeerHelpRequestV1["target"] | undefined,
    },
  };
}

export function parseHelpResponse(raw: unknown): { ok: true; value: PeerHelpResponseV1 } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "payload must be an object" };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { ok: false, error: "unsupported version" };
  if (!validateRequestId(r.request_id)) return { ok: false, error: "invalid request_id" };
  if (!["accepted", "declined", "deferred"].includes(r.decision as string)) return { ok: false, error: "invalid decision" };
  if (r.decision === "accepted" && !isNonEmptyString(r.contribution_ref)) return { ok: false, error: "contribution_ref required for accepted" };
  if (!isOptionalString(r.reason)) return { ok: false, error: "reason must be a string" };
  if (typeof r.reason === "string" && r.reason.length > MAX_REASON_LENGTH) return { ok: false, error: `reason exceeds ${MAX_REASON_LENGTH} chars` };
  if (r.retry_after !== undefined && !isISODate(r.retry_after)) return { ok: false, error: "retry_after must be ISO date" };
  return {
    ok: true,
    value: {
      version: 1,
      request_id: r.request_id as string,
      decision: r.decision as HelpDecision,
      contribution_ref: r.contribution_ref as string | undefined,
      reason_code: r.reason_code as string | undefined,
      reason: r.reason as string | undefined,
      retry_after: r.retry_after as string | undefined,
    },
  };
}

export function parseHelpStatusRequest(raw: unknown): { ok: true; value: PeerHelpStatusRequestV1 } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "payload must be an object" };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { ok: false, error: "unsupported version" };
  if (!validateRequestId(r.request_id)) return { ok: false, error: "invalid request_id" };
  if (!isNonEmptyString(r.contribution_ref)) return { ok: false, error: "invalid contribution_ref" };
  return { ok: true, value: r as unknown as PeerHelpStatusRequestV1 };
}

export function parseHelpStatus(raw: unknown): { ok: true; value: PeerHelpStatusV1 } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "payload must be an object" };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { ok: false, error: "unsupported version" };
  if (!validateRequestId(r.request_id)) return { ok: false, error: "invalid request_id" };
  if (!isNonEmptyString(r.contribution_ref)) return { ok: false, error: "invalid contribution_ref" };
  if (!["queued", "running", "awaiting_input", "completed", "failed", "withdrawal_noted"].includes(r.state as string)) return { ok: false, error: "invalid state" };
  if (!isISODate(r.updated_at)) return { ok: false, error: "invalid updated_at" };
  if (!isOptionalString(r.summary)) return { ok: false, error: "summary must be a string" };
    if (typeof r.summary === "string" && r.summary.length > MAX_SUMMARY_LENGTH) return { ok: false, error: `summary exceeds ${MAX_SUMMARY_LENGTH} chars` };
  return { ok: true, value: r as unknown as PeerHelpStatusV1 };
}

export function parseHelpWithdraw(raw: unknown): { ok: true; value: PeerHelpWithdrawV1 } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "payload must be an object" };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { ok: false, error: "unsupported version" };
  if (!validateRequestId(r.request_id)) return { ok: false, error: "invalid request_id" };
  if (!isNonEmptyString(r.contribution_ref)) return { ok: false, error: "invalid contribution_ref" };
  if (!isOptionalString(r.reason)) return { ok: false, error: "reason must be a string" };
  return { ok: true, value: r as unknown as PeerHelpWithdrawV1 };
}

export function parseContributionEvent(raw: unknown): { ok: true; value: PeerContributionEventV1 } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "payload must be an object" };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { ok: false, error: "unsupported version" };
  if (!validateRequestId(r.request_id)) return { ok: false, error: "invalid request_id" };
  if (!isNonEmptyString(r.contribution_ref)) return { ok: false, error: "invalid contribution_ref" };
  if (!isNonEmptyString(r.event_id)) return { ok: false, error: "invalid event_id" };
  if (typeof r.sequence !== "number" || r.sequence < 0) return { ok: false, error: "sequence must be a non-negative number" };
  if (!["progress", "completed", "failed", "withdrawal_noted"].includes(r.kind as string)) return { ok: false, error: "invalid kind" };
  if (!isISODate(r.occurred_at)) return { ok: false, error: "invalid occurred_at" };
  return { ok: true, value: r as unknown as PeerContributionEventV1 };
}

export function canonicalRequestHash(request: PeerHelpRequestV1): string {
  const { createHash } = require("node:crypto");
  const normal: Record<string, unknown> = {
    version: request.version,
    request_id: request.request_id,
    goal: request.goal,
    required_capabilities: [...request.required_capabilities].sort(),
  };
  if (request.context) normal.context = request.context;
  if (request.priority) normal.priority = request.priority;
  if (request.target) {
    const t = request.target as Record<string, unknown>;
    normal.target = { executor: t.executor, ...(t.executor === "pi" ? { workspace_alias: t.workspace_alias } : {}) };
  }
  return createHash("sha256").update(JSON.stringify(normal)).digest("hex");
}

export function generateContributionRef(): string {
  return `help_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
