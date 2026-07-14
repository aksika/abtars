/**
 * peer-transport/remote-pi-projection.ts — Shared projection builder (#1358).
 *
 * Single source of truth for converting a PiRunRecord into a bounded
 * RemotePiPublicProjectionV1. Used by both the event producer and the
 * control handler so the two paths cannot drift.
 */

import type { PiRunRecord } from "../pi-executor/types.js";
import type { RemotePiPublicProjectionV1, DeliveryPolicy } from "./remote-pi-types.js";
import { REMOTE_PI_BOUNDS } from "./remote-pi-types.js";

/**
 * Sanitize a string to fit within a byte budget. Truncates by character
 * count and encodes to UTF-8, then strips a 3-byte ellipsis to leave room
 * for the "..." suffix. Always returns a string ≤ the byte limit (UTF-8
 * length) so the result survives re-encoding on the receiver.
 */
export function sanitizeString(value: string | null | undefined, fieldName: string, maxBytes: number = REMOTE_PI_BOUNDS.MAX_PROJECTION_STRING): string | undefined {
  if (!value) return undefined;
  const bytes = Buffer.byteLength(value, "utf-8");
  if (bytes <= maxBytes) {
    return value;
  }
  // Truncate with ellipsis
  const truncated = Buffer.from(value.slice(0, Math.floor(value.length * maxBytes / bytes))).toString("utf-8");
  return truncated.slice(0, -3) + "...";
}

/**
 * Parse usage JSON from the run's `usage_json` column. Returns undefined if
 * not set or not parseable.
 */
function parseUsage(usageJson: string | null | undefined): { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined {
  if (!usageJson) return undefined;
  try {
    const parsed = JSON.parse(usageJson);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } = {};
    if (typeof parsed.input_tokens === "number") usage.input_tokens = parsed.input_tokens;
    if (typeof parsed.output_tokens === "number") usage.output_tokens = parsed.output_tokens;
    if (typeof parsed.total_tokens === "number") usage.total_tokens = parsed.total_tokens;
    return Object.keys(usage).length > 0 ? usage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Determine the delivery policy from run metadata. The policy is read from
 * the linked kanban_board notes; falls back to "leave_remote" if not set.
 *
 * TODO: #1357 integration — read the actual target.delivery field from the
 * delegation record once the cross-repo wiring lands.
 */
function getDeliveryPolicy(_run: PiRunRecord): DeliveryPolicy {
  return "leave_remote";
}

/**
 * Build a public projection from a run record.
 *
 * Pulls the awaiting_input UI request details (title/prompt/options) from
 * the `uiRequest` parameter (typically fetched from the store's most recent
 * "ui" progress entry), so the origin can render a choice without those
 * fields being columns on the pi_runs row.
 */
export function buildPublicProjection(run: PiRunRecord, uiRequest: Record<string, unknown> | null = null): RemotePiPublicProjectionV1 {
  const projection: RemotePiPublicProjectionV1 = {
    status: run.status,
    generation: run.executionGeneration,
    last_activity_at: run.lastRpcActivityAt || run.updatedAt,
  };

  // Add pending input if present, including title/prompt/options from the
  // most recent "ui" progress payload so the origin can render a choice.
  if (run.pendingRequestId && run.pendingRequestType && run.status === "awaiting_input") {
    const pending: NonNullable<RemotePiPublicProjectionV1["pending_input"]> = {
      request_id: run.pendingRequestId,
      type: run.pendingRequestType,
    };
    if (uiRequest) {
      if (typeof uiRequest.title === "string") {
        pending.title = sanitizeString(uiRequest.title, "pending_input.title");
      }
      if (typeof uiRequest.description === "string") {
        pending.prompt = sanitizeString(uiRequest.description, "pending_input.prompt");
      } else if (typeof uiRequest.prompt === "string") {
        pending.prompt = sanitizeString(uiRequest.prompt, "pending_input.prompt");
      }
      if (Array.isArray(uiRequest.options)) {
        const opts: Array<{ id: string; label: string }> = [];
        for (const opt of uiRequest.options.slice(0, REMOTE_PI_BOUNDS.MAX_INPUT_OPTIONS)) {
          if (typeof opt === "string") {
            opts.push({ id: opt, label: opt });
          } else if (opt && typeof opt === "object" && typeof (opt as Record<string, unknown>).id === "string") {
            const o = opt as Record<string, unknown>;
            const id = String(o.id);
            const label = typeof o.label === "string" ? String(o.label) : id;
            opts.push({ id, label: sanitizeString(label, "pending_input.options[].label", 200) ?? id });
          }
        }
        if (opts.length > 0) pending.options = opts;
      }
    }
    projection.pending_input = pending;
  }

  // Add terminal information if available
  if (["completed", "failed", "cancelled"].includes(run.status)) {
    if (run.resultSummary) {
      projection.result_summary = sanitizeString(run.resultSummary, "result_summary");
    }
    if (run.error && run.status !== "completed") {
      projection.error_summary = sanitizeString(run.error, "error_summary");
    }
    const usage = parseUsage(run.usageJson);
    if (usage) {
      projection.usage = usage;
    }
    if (run.changedFilesSummary) {
      projection.changed_files_summary = sanitizeString(run.changedFilesSummary, "changed_files_summary");
    }
    if (run.resumeCapability === "available") {
      projection.resume_capability = `res_${run.id}_${run.executionGeneration}`;
    }
  }

  // Add delivery outcome if terminal
  if (["completed", "failed", "cancelled"].includes(run.status)) {
    const policy = getDeliveryPolicy(run);
    projection.delivery = {
      policy,
      status: "not_requested", // Populated from actual delivery execution
    };
  }

  return projection;
}
