/**
 * peer-transport/remote-pi-event-producer.ts — Owner-side lifecycle event producer (#1358).
 *
 * Converts Pi run state transitions into safe, bounded public lifecycle events
 * and appends them to the durable outbox.
 */

import type { PiRunRecord } from "../pi-executor/types.js";
import type { PiRunStore } from "../pi-executor/pi-run-store.js";
import type {
  RemotePiEventV1,
  RemotePiEventKind,
  RemotePiPublicProjectionV1,
  DeliveryPolicy,
  DeliveryStatus,
} from "./remote-pi-types.js";
import {
  computeSha256,
  deriveEventId,
  validatePublicProjection,
  validateBoundedString,
  REMOTE_PI_BOUNDS,
} from "./remote-pi-types.js";
import { logInfo, logDebug, logTrace } from "../logger.js";

const TAG = "remote-pi-event-producer";

export interface EventProducerDeps {
  store: PiRunStore;
}

/**
 * Sanitizes a string to fit within bounds.
 */
function sanitizeString(value: string | null | undefined, fieldName: string): string | undefined {
  if (!value) return undefined;
  const bytes = Buffer.byteLength(value, "utf-8");
  if (bytes <= REMOTE_PI_BOUNDS.MAX_PROJECTION_STRING) {
    return value;
  }
  // Truncate with ellipsis
  const truncated = Buffer.from(value.slice(0, Math.floor(value.length * REMOTE_PI_BOUNDS.MAX_PROJECTION_STRING / bytes))).toString("utf-8");
  return truncated.slice(0, -3) + "...";
}

/**
 * Parse usage from JSON string if present.
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
 * Determine delivery policy from run metadata (stored in kanban_board notes).
 */
function getDeliveryPolicy(run: PiRunRecord): DeliveryPolicy {
  // The delivery policy is stored in the kanban_board notes as JSON
  // For now, default to leave_remote unless we have specific metadata
  // This would be enhanced by #1357 integration
  return "leave_remote";
}

/**
 * Build a public projection from a run record.
 */
export function buildPublicProjection(run: PiRunRecord): RemotePiPublicProjectionV1 {
  const projection: RemotePiPublicProjectionV1 = {
    status: run.status,
    generation: run.executionGeneration,
    last_activity_at: run.lastRpcActivityAt || run.updatedAt,
  };

  // Add pending input if present
  if (run.pendingRequestId && run.pendingRequestType && run.status === "awaiting_input") {
    projection.pending_input = {
      request_id: run.pendingRequestId,
      type: run.pendingRequestType,
      // Title, prompt, and options would come from the request ledger
      // For now, we only include the minimal required fields
    };
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
      // A resume capability token would be generated here
      // For now, we use a placeholder derived from run metadata
      projection.resume_capability = `res_${run.id}_${run.executionGeneration}`;
    }
  }

  // Add delivery outcome if terminal
  if (["completed", "failed", "cancelled"].includes(run.status)) {
    const policy = getDeliveryPolicy(run);
    projection.delivery = {
      policy,
      status: "not_requested", // Would be populated from actual delivery execution
    };
  }

  return projection;
}

/**
 * Coalesce progress payload to fit bounds.
 */
function coalesceProgressPayload(kind: string, payload: string): string {
  try {
    const parsed = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) return "{}";

    // Limit progress payload size
    const bytes = Buffer.byteLength(payload, "utf-8");
    if (bytes <= REMOTE_PI_BOUNDS.MAX_PROJECTION_STRING) {
      return payload;
    }

    // Create a minimal progress summary
    const minimal: Record<string, unknown> = {
      kind,
      timestamp: new Date().toISOString(),
    };
    if (parsed.step !== undefined) minimal.step = String(parsed.step).slice(0, 50);
    if (parsed.message !== undefined) minimal.message = String(parsed.message).slice(0, 200);
    if (parsed.percent !== undefined) minimal.percent = Math.min(100, Math.max(0, Number(parsed.percent) || 0));

    return JSON.stringify(minimal);
  } catch {
    return "{}";
  }
}

/**
 * Owner-side event producer for remote Pi lifecycle.
 */
export class RemotePiEventProducer {
  private readonly deps: EventProducerDeps;

  constructor(deps: EventProducerDeps) {
    this.deps = deps;
  }

  /**
   * Produce and append a lifecycle event for a run.
   * This should be called within the same transaction as the state transition.
   */
  async produceEvent(input: {
    run: PiRunRecord;
    kind: RemotePiEventKind;
    originPeer: string;
    originRequestId: string;
    progressPayload?: string; // For progress events
  }): Promise<{ sequence: number; eventId: string } | null> {
    const { run, kind, originPeer, originRequestId, progressPayload } = input;

    // Validate that the run has the required fields for remote events
    if (!run.originPeer || run.originPeer !== originPeer) {
      logDebug(TAG, `Skipping event for run ${run.id}: origin_peer mismatch or missing`);
      return null;
    }

    // Build public projection
    const projection = buildPublicProjection(run);
    validatePublicProjection(projection);

    // Coalesce progress payload if needed
    if (kind === "progress" && progressPayload) {
      // Progress events don't need full projection, just minimal state
      projection.result_summary = coalesceProgressPayload(kind, progressPayload);
    }

    const projectionJson = JSON.stringify(projection);

    // Allocate sequence
    const sequence = this.deps.store.allocateNextSequence(run.id);
    const eventId = deriveEventId(run.id, sequence);

    // Compute content hash
    const contentSha256 = await computeSha256(JSON.stringify({
      version: 1,
      event_id: eventId,
      run_id: run.id,
      card_id: run.cardId,
      generation: run.executionGeneration,
      sequence,
      kind,
      origin_peer: originPeer,
      origin_request_id: originRequestId,
      projection: projectionJson,
    }));

    // Append to outbox
    const appended = this.deps.store.appendEvent({
      runId: run.id,
      generation: run.executionGeneration,
      sequence,
      eventId,
      contentSha256,
      originPeer,
      originRequestId,
      kind,
      projectionJson,
    });

    if (!appended) {
      logDebug(TAG, `Failed to append event for run ${run.id} sequence ${sequence}: conflicting event`);
      return null;
    }

    logTrace(TAG, `Produced event ${eventId} for run ${run.id} kind=${kind} sequence=${sequence}`);

    return { sequence, eventId };
  }

  /**
   * Produce an event from a Pi run state transition.
   * Maps run status to event kind and produces the appropriate event.
   */
  async produceFromTransition(input: {
    run: PiRunRecord;
    previousStatus?: string;
    originPeer: string;
    originRequestId: string;
    progressPayload?: string;
  }): Promise<{ sequence: number; eventId: string; kind: RemotePiEventKind } | null> {
    const { run, previousStatus, originPeer, originRequestId, progressPayload } = input;

    // Map status to event kind
    let kind: RemotePiEventKind;
    switch (run.status) {
      case "queued":
        kind = "queued";
        break;
      case "starting":
        kind = "starting";
        break;
      case "running":
        kind = "running";
        break;
      case "awaiting_input":
        kind = "awaiting_input";
        break;
      case "cancelling":
        kind = "cancelling";
        break;
      case "interrupted":
        kind = "interrupted";
        break;
      case "completed":
        kind = "completed";
        break;
      case "failed":
        kind = "failed";
        break;
      case "cancelled":
        kind = "cancelled";
        break;
      default:
        logDebug(TAG, `Unknown run status ${run.status}, skipping event`);
        return null;
    }

    // Don't emit events for internal-only transitions
    if (previousStatus && previousStatus === run.status) {
      return null;
    }

    // Special handling for input_cleared event (transition away from awaiting_input)
    if (previousStatus === "awaiting_input" && run.status === "running") {
      const result = await this.produceEvent({
        run: { ...run, status: "running" },
        kind: "input_cleared",
        originPeer,
        originRequestId,
      });
      if (result) {
        logInfo(TAG, `Produced input_cleared event for run ${run.id}`);
        return { ...result, kind: "input_cleared" };
      }
    }

    // Produce the main event
    const result = await this.produceEvent({
      run,
      kind,
      originPeer,
      originRequestId,
      progressPayload,
    });

    if (!result) return null;

    logInfo(TAG, `Produced ${kind} event for run ${run.id} sequence=${result.sequence}`);

    return { ...result, kind };
  }

  /**
   * Produce a progress event for a run.
   * Progress events are coalesced and sampled, not emitted for every RPC.
   */
  async produceProgress(input: {
    run: PiRunRecord;
    originPeer: string;
    originRequestId: string;
    progressPayload: string;
  }): Promise<{ sequence: number; eventId: string } | null> {
    return this.produceEvent({
      run: input.run,
      kind: "progress",
      originPeer: input.originPeer,
      originRequestId: input.originRequestId,
      progressPayload: input.progressPayload,
    });
  }

  /**
   * Produce a resumed event after a successful resume command.
   */
  async produceResumed(input: {
    run: PiRunRecord;
    newGeneration: number;
    originPeer: string;
    originRequestId: string;
  }): Promise<{ sequence: number; eventId: string } | null> {
    const result = await this.produceEvent({
      run: { ...input.run, executionGeneration: input.newGeneration, status: "queued" },
      kind: "resumed",
      originPeer: input.originPeer,
      originRequestId: input.originRequestId,
    });

    if (result) {
      logInfo(TAG, `Produced resumed event for run ${input.run.id} generation ${input.newGeneration}`);
    }

    return result;
  }

  /**
   * Get unacknowledged events for a run (for push delivery).
   */
  getUnacknowledgedEvents(runId: string, limit: number = 50) {
    return this.deps.store.getUnacknowledgedEvents(runId, limit);
  }

  /**
   * Get events for a run after a given sequence (for catch-up).
   */
  getEventsAfter(runId: string, afterSequence: number, limit: number = 100) {
    return this.deps.store.getEventsAfter({ runId, afterSequence, limit });
  }

  /**
   * Acknowledge events for a run.
   */
  acknowledgeEvents(runId: string, upToSequence: number): number {
    const count = this.deps.store.acknowledgeEvents(runId, upToSequence);
    if (count > 0) {
      logDebug(TAG, `Acknowledged ${count} events for run ${runId} up to sequence ${upToSequence}`);
    }
    return count;
  }

  /**
   * Compact old progress events for a run.
   */
  compactProgressEvents(runId: string, maxProgressToRetain: number = 50): number {
    const count = this.deps.store.compactProgressEvents(runId, maxProgressToRetain);
    if (count > 0) {
      logDebug(TAG, `Compacted ${count} progress events for run ${runId}`);
    }
    return count;
  }

  /**
   * Build a complete event envelope from stored event data.
   */
  async buildEventEnvelope(row: {
    run_id: string;
    generation: number;
    sequence: number;
    event_id: string;
    content_sha256: string;
    origin_peer: string;
    origin_request_id: string;
    kind: string;
    projection_json: string;
    created_at: string;
  }): Promise<RemotePiEventV1> {
    const projection = JSON.parse(row.projection_json) as RemotePiPublicProjectionV1;
    validatePublicProjection(projection);

    return {
      version: 1,
      event_id: row.event_id,
      content_sha256: row.content_sha256,
      origin_peer: row.origin_peer,
      origin_request_id: row.origin_request_id,
      run_id: row.run_id,
      card_id: 0, // Would be looked up from the run
      generation: row.generation,
      sequence: row.sequence,
      kind: row.kind as RemotePiEventKind,
      occurred_at: row.created_at,
      projection,
    };
  }
}