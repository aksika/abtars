/**
 * peer-transport/remote-pi-delivery.ts — Event delivery and catch-up (#1358).
 *
 * Handles WSS push delivery, HTTPS/WSS pull/catch-up, and acknowledgement
 * of lifecycle events from owner to origin.
 */

import type { RemotePiEventV1, RemotePiEventsListRequestV1, RemotePiEventsListResponseV1, RemotePiEventsAckRequestV1, RemotePiEventsAckResponseV1, RemotePiEventCursor } from "./remote-pi-types.js";
import { validateEventV1, REMOTE_PI_BOUNDS, deriveEventId } from "./remote-pi-types.js";
import type { RemotePiEventProducer } from "./remote-pi-event-producer.js";
import type { PiRunStore } from "../pi-executor/pi-run-store.js";
import type { WsPeerClient } from "./ws-peer-client.js";
import { logInfo, logDebug, logTrace, logError } from "../logger.js";
import { computeSha256 } from "./remote-pi-types.js";

const TAG = "remote-pi-delivery";

export interface DeliveryDeps {
  store: PiRunStore;
  eventProducer: RemotePiEventProducer;
}

/**
 * Event listener for lifecycle updates.
 */
export interface RemotePiEventListener {
  (event: RemotePiEventV1): void;
}

/**
 * Configuration for delivery behavior.
 */
export interface DeliveryConfig {
  /** Maximum events per push batch */
  maxPushBatch: number;
  /** Maximum events per catch-up request */
  maxCatchUpBatch: number;
  /** Push retry interval (ms) */
  pushRetryInterval: number;
  /** Maximum concurrent catch-up streams */
  maxConcurrentCatchUp: number;
}

const DEFAULT_CONFIG: DeliveryConfig = {
  maxPushBatch: 10,
  maxCatchUpBatch: 100,
  pushRetryInterval: 5000,
  maxConcurrentCatchUp: 3,
};

/**
 * Owner-side event delivery manager.
 */
export class RemotePiDeliveryManager {
  private readonly deps: DeliveryDeps;
  private readonly config: DeliveryConfig;
  private readonly wsClients = new Map<string, WsPeerClient>();
  private readonly eventListeners = new Map<string, RemotePiEventListener[]>();
  private readonly activeCatchUp = new Map<string, Promise<void>>(); // run_id -> catch-up promise

  constructor(deps: DeliveryDeps, config: Partial<DeliveryConfig> = {}) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a WS client for a peer.
   */
  registerWsClient(peerName: string, client: WsPeerClient): void {
    this.wsClients.set(peerName, client);
    logDebug(TAG, `Registered WS client for peer ${peerName}`);
  }

  /**
   * Unregister a WS client for a peer.
   */
  unregisterWsClient(peerName: string): void {
    this.wsClients.delete(peerName);
    logDebug(TAG, `Unregistered WS client for peer ${peerName}`);
  }

  /**
   * Add an event listener for a run.
   */
  addEventListener(runId: string, listener: RemotePiEventListener): () => void {
    if (!this.eventListeners.has(runId)) {
      this.eventListeners.set(runId, []);
    }
    this.eventListeners.get(runId)!.push(listener);

    // Return unsubscribe function
    return () => {
      const listeners = this.eventListeners.get(runId);
      if (listeners) {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      }
    };
  }

  /**
   * Push unacknowledged events for a run via WS if connected.
   */
  async pushEvents(runId: string, originPeer: string): Promise<number> {
    const ws = this.wsClients.get(originPeer);
    if (!ws || !ws.connected) {
      logTrace(TAG, `Cannot push events for run ${runId}: ${originPeer} not connected`);
      return 0;
    }

    // Get unacknowledged events
    const events = this.deps.store.getUnacknowledgedEvents(runId, this.config.maxPushBatch);
    if (events.length === 0) {
      return 0;
    }

    logDebug(TAG, `Pushing ${events.length} events for run ${runId} to ${originPeer}`);

    let pushed = 0;
    for (const row of events) {
      try {
        const event = await this.deps.eventProducer.buildEventEnvelope(row);
        this._validateEvent(event);

        // Send via WS
        await ws.send("pi.lifecycle.v1", event);
        pushed++;
        logTrace(TAG, `Pushed event ${event.event_id} for run ${runId}`);
      } catch (err) {
        logError(TAG, `Failed to push event for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
        // Continue with next event
      }
    }

    return pushed;
  }

  /**
   * Drain unacknowledged events for all runs to connected peers.
   * Called on connection events and during heartbeat/reconciliation.
   */
  async drainOutbox(): Promise<{ pushed: number; failed: number }> {
    let pushed = 0;
    let failed = 0;

    // Get all runs with unacknowledged events
    const rows = this.deps.store.fallsWithUnacknowledgedEvents();

    logDebug(TAG, `Draining outbox for ${rows.length} runs`);

    for (const { run_id, origin_peer } of rows) {
      try {
        const count = await this.pushEvents(run_id, origin_peer);
        pushed += count;
        if (count === 0) {
          failed++;
        }
      } catch (err) {
        logError(TAG, `Failed to drain events for run ${run_id}: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }

    return { pushed, failed };
  }

  /**
   * Handle an inbound lifecycle event (origin side).
   * Validates, reduces, and acknowledges.
   */
  async handleInboundEvent(
    authenticatedPeer: string,
    event: RemotePiEventV1,
    onReduce?: (event: RemotePiEventV1) => Promise<void>
  ): Promise<{ accepted: boolean; reason?: string }> {
    try {
      // Validate event
      this._validateEvent(event);

      // Verify peer ownership
      if (event.origin_peer !== authenticatedPeer) {
        return { accepted: false, reason: "Event origin_peer does not match authenticated peer" };
      }

      // Check for duplicate with different content
      const existing = this.deps.store.getEventsAfter(event.run_id, event.sequence - 1, 1).find(e => e.sequence === event.sequence);
      if (existing) {
        if (existing.content_sha256 !== event.content_sha256) {
          return { accepted: false, reason: "Conflicting event hash" };
        }
        // Idempotent duplicate - accept but don't re-process
        logTrace(TAG, `Ignoring duplicate event ${event.event_id}`);
        return { accepted: true };
      }

      // Check for gaps
      const maxSeq = this.deps.store.getMaxSequence(event.run_id);
      if (event.sequence > maxSeq + 1) {
        logDebug(TAG, `Gap detected for run ${event.run_id}: have ${maxSeq}, got ${event.sequence}`);
        // Still accept but trigger catch-up later
      }

      // Store event locally (origin side would have its own storage)
      // For now, we just reduce and acknowledge

      // Call reduce callback
      if (onReduce) {
        await onReduce(event);
      }

      // Fire local listeners
      const listeners = this.eventListeners.get(event.run_id) || [];
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          logError(TAG, `Event listener error for run ${event.run_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Acknowledge
      await this.acknowledgeEvent(authenticatedPeer, event.run_id, event.sequence);

      logTrace(TAG, `Accepted event ${event.event_id} for run ${event.run_id}`);

      return { accepted: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(TAG, `Failed to handle inbound event: ${message}`);
      return { accepted: false, reason: message };
    }
  }

  /**
   * List events for a run (owner side, for catch-up).
   */
  async listEvents(request: RemotePiEventsListRequestV1, authenticatedPeer: string): Promise<RemotePiEventsListResponseV1 | { error: string }> {
    // Verify request version
    if (request.version !== 1) {
      return { error: `Unsupported request version: ${request.version}` };
    }

    // Verify limit
    const limit = Math.min(request.limit ?? this.config.maxCatchUpBatch, REMOTE_PI_BOUNDS.MAX_EVENTS_PER_LIST);

    // Verify peer owns this run
    const run = this.deps.store.get(request.run_id);
    if (!run) {
      return { error: `Run ${request.run_id} not found` };
    }
    if (run.originPeer !== authenticatedPeer) {
      return { error: "Run belongs to a different peer" };
    }

    // Get events
    const events = this.deps.store.getEventsAfter(request.run_id, request.after_sequence, limit);

    logDebug(TAG, `Listed ${events.length} events for run ${request.run_id} after seq ${request.after_sequence}`);

    // Build response
    const eventEnvelopes = await Promise.all(
      events.map(row => this.deps.eventProducer.buildEventEnvelope(row))
    );

    return {
      version: 1,
      run_id: request.run_id,
      events: eventEnvelopes,
      has_more: events.length >= limit,
    };
  }

  /**
   * Acknowledge events for a run (owner side).
   */
  acknowledgeEvent(authenticatedPeer: string, runId: string, sequence: number): RemotePiEventsAckResponseV1 | { error: string } {
    // Verify peer owns this run
    const run = this.deps.store.get(runId);
    if (!run) {
      return { error: `Run ${runId} not found` };
    }
    if (run.originPeer !== authenticatedPeer) {
      return { error: "Run belongs to a different peer" };
    }

    // Verify sequence exists
    const maxSeq = this.deps.store.getMaxSequence(runId);
    if (sequence > maxSeq) {
      return { error: `Sequence ${sequence} exceeds max sequence ${maxSeq}` };
    }

    // Acknowledge
    const count = this.deps.store.acknowledgeEvents(runId, sequence);
    logDebug(TAG, `Acknowledged ${count} events for run ${runId} up to seq ${sequence}`);

    return {
      version: 1,
      run_id: runId,
      acknowledged_sequence: sequence,
    };
  }

  /**
   * Trigger catch-up for a run (origin side).
   */
  async catchUp(runId: string, ownerPeer: string, currentCursor: number, onEvent: (event: RemotePiEventV1) => Promise<void>): Promise<number> {
    // Prevent concurrent catch-up for the same run
    const existing = this.activeCatchUp.get(runId);
    if (existing) {
      await existing;
      return 0;
    }

    const catchUpPromise = this._doCatchUp(runId, ownerPeer, currentCursor, onEvent);
    this.activeCatchUp.set(runId, catchUpPromise);

    try {
      return await catchUpPromise;
    } finally {
      this.activeCatchUp.delete(runId);
    }
  }

  /**
   * Perform catch-up for a run.
   */
  private async _doCatchUp(
    runId: string,
    ownerPeer: string,
    currentCursor: number,
    onEvent: (event: RemotePiEventV1) => Promise<void>
  ): Promise<number> {
    let fetched = 0;
    let hasMore = true;
    let cursor = currentCursor;

    logInfo(TAG, `Starting catch-up for run ${runId} from cursor ${cursor}`);

    const ws = this.wsClients.get(ownerPeer);
    if (!ws || !ws.connected) {
      logError(TAG, `Cannot catch-up: ${ownerPeer} not connected`);
      return 0;
    }

    while (hasMore && fetched < REMOTE_PI_BOUNDS.MAX_EVENTS_PER_LIST * 10) {
      const request: RemotePiEventsListRequestV1 = {
        version: 1,
        run_id: runId,
        after_sequence: cursor,
        limit: this.config.maxCatchUpBatch,
      };

      try {
        const response = await ws.call("pi.events.list.v1", request) as RemotePiEventsListResponseV1 | { error: string };

        if ("error" in response) {
          logError(TAG, `Catch-up failed for run ${runId}: ${response.error}`);
          break;
        }

        for (const event of response.events) {
          this._validateEvent(event);
          await onEvent(event);
          fetched++;
          cursor = event.sequence;
        }

        hasMore = response.has_more;

        // Acknowledge batch
        if (fetched > 0) {
          await ws.call("pi.events.ack.v1", {
            version: 1,
            run_id: runId,
            sequence: cursor,
          } as RemotePiEventsAckRequestV1);
        }

        logTrace(TAG, `Catch-up progress: ${fetched} events, cursor=${cursor}`);
      } catch (err) {
        logError(TAG, `Catch-up error for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }

    logInfo(TAG, `Catch-up complete for run ${runId}: ${fetched} events fetched`);

    return fetched;
  }

  /**
   * Validate an event envelope.
   */
  private _validateEvent(event: RemotePiEventV1): void {
    // Schema validation
    validateEventV1(event);

    // Size validation
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf-8");
    if (bytes > REMOTE_PI_BOUNDS.MAX_EVENT_SIZE) {
      throw new Error(`Event exceeds ${REMOTE_PI_BOUNDS.MAX_EVENT_SIZE} bytes`);
    }

    // Verify event_id matches derived value
    const expectedId = deriveEventId(event.run_id, event.sequence);
    if (event.event_id !== expectedId) {
      throw new Error(`Event ID mismatch: expected ${expectedId}, got ${event.event_id}`);
    }

    // Verify content_sha256
    const canonical = JSON.stringify({
      version: event.version,
      event_id: event.event_id,
      run_id: event.run_id,
      card_id: event.card_id,
      generation: event.generation,
      sequence: event.sequence,
      kind: event.kind,
      origin_peer: event.origin_peer,
      origin_request_id: event.origin_request_id,
      occurred_at: event.occurred_at,
      projection: event.projection,
    });
    const expectedHash = computeSha256(canonical);
    if (event.content_sha256 !== expectedHash) {
      throw new Error(`Content hash mismatch for event ${event.event_id}`);
    }
  }
}