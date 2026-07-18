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
} from "./remote-pi-types.js";
import {
  computeEventHash,
  deriveEventId,
  validatePublicProjection,
} from "./remote-pi-types.js";
import { buildPublicProjection, sanitizeString } from "./remote-pi-projection.js";
import { logInfo, logDebug, logTrace } from "../logger.js";

/** Re-exported for callers (e.g. tests) that imported the symbol from this
 * module before the projection builder was extracted to its own file. */
export { buildPublicProjection };

const TAG = "remote-pi-event-producer";

export interface EventProducerDeps {
  store: PiRunStore;
}

/**
 * Coalesce a raw progress payload into a bounded typed projection field.
 * Drops everything but `step`, `message`, and `percent`; caps each field by
 * byte count so the result fits the projection bounds.
 */
function coalesceProgress(payload: string): RemotePiPublicProjectionV1["progress"] {
  if (!payload) return undefined;
  let parsed: Record<string, unknown> = {};
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      parsed = obj as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  const MAX_STEP_BYTES = 200;
  const MAX_MESSAGE_BYTES = 1_000;
  const out: { step?: string; message?: string; percent?: number } = {};

  if (typeof parsed.step === "string") {
    out.step = sanitizeString(parsed.step, "progress.step", MAX_STEP_BYTES);
  }
  if (typeof parsed.message === "string") {
    out.message = sanitizeString(parsed.message, "progress.message", MAX_MESSAGE_BYTES);
  }
  if (typeof parsed.percent === "number" && Number.isFinite(parsed.percent)) {
    out.percent = Math.min(100, Math.max(0, Math.trunc(parsed.percent)));
  }

  return Object.keys(out).length > 0 ? out : undefined;
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

    // Build public projection. Pull the most recent UI request details
    // (title/prompt/options) from progress entries so awaiting_input events
    // carry the bounded public projection the spec requires.
    const uiRequest = run.pendingRequestId && run.status === "awaiting_input"
      ? this.deps.store.getLatestUiRequest(run.id)
      : null;
    const projection = buildPublicProjection(run, uiRequest);
    validatePublicProjection(projection);

    // Attach coalesced progress payload to the dedicated `progress` field.
    // Never overwrite terminal fields (result_summary) with progress data.
    if (kind === "progress" && progressPayload) {
      projection.progress = coalesceProgress(progressPayload);
    }

    // The occurred_at timestamp is stable for the duration of this call.
    // Two concurrent producers can share the same ms-granularity timestamp
    // and that's fine — the sequence is what makes the events unique.
    const occurredAt = new Date().toISOString();
    const projectionJson = JSON.stringify(projection);

    // Atomic allocate + append inside a single transaction. The store
    // allocates the next sequence, then invokes computeFields to derive
    // eventId and content_sha256. We never compute a hash for a sequence
    // we didn't actually get, so concurrent producers cannot collide.
    let sequence: number;
    let eventId: string;
    try {
      const result = this.deps.store.appendEventAuto({
        runId: run.id,
        cardId: run.cardId,
        generation: run.executionGeneration,
        originPeer,
        originRequestId,
        kind,
        occurredAt,
        projectionJson,
        computeFields: (seq) => {
          const eId = deriveEventId(run.id, seq);
          const hash = computeEventHash({
            version: 1,
            event_id: eId,
            origin_peer: originPeer,
            origin_request_id: originRequestId,
            run_id: run.id,
            card_id: run.cardId,
            generation: run.executionGeneration,
            sequence: seq,
            kind,
            occurred_at: occurredAt,
            projection,
          });
          return { eventId: eId, contentSha256: hash };
        },
      });
      sequence = result.sequence;
      eventId = result.idempotent
        ? deriveEventId(run.id, result.sequence)
        : deriveEventId(run.id, result.sequence);
    } catch (err) {
      // Conflicting content for the same sequence — surface as a no-op so
      // the caller can decide whether to retry with a fresh timestamp or
      // escalate. This is the only path that drops an event.
      logDebug(TAG,
        `Skipping event for run ${run.id} kind=${kind}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
   * Uses the card_id and occurred_at stored alongside the event.
   */
  buildEventEnvelope(row: {
    run_id: string;
    card_id: number;
    generation: number;
    sequence: number;
    event_id: string;
    content_sha256: string;
    origin_peer: string;
    origin_request_id: string;
    kind: string;
    projection_json: string;
    occurred_at: string;
    created_at: string;
  }): RemotePiEventV1 {
    const projection = JSON.parse(row.projection_json) as RemotePiPublicProjectionV1;

    return {
      version: 1,
      event_id: row.event_id,
      content_sha256: row.content_sha256,
      origin_peer: row.origin_peer,
      origin_request_id: row.origin_request_id,
      run_id: row.run_id,
      card_id: row.card_id,
      generation: row.generation,
      sequence: row.sequence,
      kind: row.kind as RemotePiEventKind,
      occurred_at: row.occurred_at,
      projection,
    };
  }
}