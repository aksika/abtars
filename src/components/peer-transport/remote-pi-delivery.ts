/**
 * peer-transport/remote-pi-delivery.ts — Event delivery and catch-up (#1358, #1455).
 *
 * Handles WSS push delivery, HTTPS/WSS pull/catch-up, and acknowledgement
 * of lifecycle events from owner to origin. No longer discovers or registers
 * private WsPeerClient instances — uses the broker-backed route interface.
 */

import type { RemotePiEventV1, RemotePiEventsListRequestV1, RemotePiEventsListResponseV1, RemotePiEventsAckRequestV1, RemotePiEventsAckResponseV1 } from "./remote-pi-types.js";
import { validateEventV1, REMOTE_PI_BOUNDS } from "./remote-pi-types.js";
import type { RemotePiEventProducer } from "./remote-pi-event-producer.js";
import type { PiRunStore } from "../pi-executor/pi-run-store.js";
import { logInfo, logDebug, logTrace, logError } from "../logger.js";

const TAG = "remote-pi-delivery";

export interface RemotePiRoute {
  hasRoute(peer: string): boolean;
  sendPush(peer: string, method: "pi.lifecycle.v1", payload: unknown): boolean;
  requestConnection(peer: string, reason: "outbox"): void;
}

export interface DeliveryDeps {
  store: PiRunStore;
  eventProducer: RemotePiEventProducer;
  /** Local peer name (for origin-side inbound event ownership checks) */
  localPeerName?: string;
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
  private readonly eventListeners = new Map<string, RemotePiEventListener[]>();
  private readonly activeCatchUp = new Map<string, Promise<number>>();
  private readonly drainInFlight = new Map<string, Promise<void>>();
  private route: RemotePiRoute | null = null;

  constructor(deps: DeliveryDeps, config: Partial<DeliveryConfig> = {}) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Inject the route interface for broker-aware WSS push and connection demand.
   */
  setRouteInterface(route: RemotePiRoute): void {
    this.route = route;
  }

  /**
   * Add an event listener for a run.
   */
  addEventListener(runId: string, listener: RemotePiEventListener): () => void {
    if (!this.eventListeners.has(runId)) {
      this.eventListeners.set(runId, []);
    }
    this.eventListeners.get(runId)!.push(listener);

    return () => {
      const listeners = this.eventListeners.get(runId);
      if (listeners) {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      }
    };
  }

  /**
   * Push unacknowledged events for a run via route interface.
   */
  async pushEvents(runId: string, originPeer: string): Promise<number> {
    if (!this.route || !this.route.hasRoute(originPeer)) {
      logTrace(TAG, `Cannot push events for run ${runId}: ${originPeer} not connected`);
      if (this.route) {
        this.route.requestConnection(originPeer, "outbox");
      }
      return 0;
    }

    const events = this.deps.store.getUnacknowledgedEvents(runId, this.config.maxPushBatch);
    if (events.length === 0) {
      return 0;
    }

    logDebug(TAG, `Pushing ${events.length} events for run ${runId} to ${originPeer}`);

    let pushed = 0;
    for (const row of events) {
      try {
        const event = this.deps.eventProducer.buildEventEnvelope(row);
        this._validateEvent(event);

        if (this.route.sendPush(originPeer, "pi.lifecycle.v1", event)) {
          pushed++;
          logTrace(TAG, `Pushed event ${event.event_id} for run ${runId}`);
        }
      } catch (err) {
        logError(TAG, `Failed to push event for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return pushed;
  }

  /**
   * Drain pending events for a specific peer (triggered by route-available).
   * Coalesces concurrent drains for the same peer.
   */
  async drainPeer(peer: string): Promise<void> {
    const existing = this.drainInFlight.get(peer);
    if (existing) return existing;

    const promise = this._drainPeer(peer);
    this.drainInFlight.set(peer, promise);
    try {
      await promise;
    } finally {
      this.drainInFlight.delete(peer);
    }
  }

  private async _drainPeer(peer: string): Promise<void> {
    const rows = this.deps.store.findRunsWithUnacknowledgedEvents();
    const peerRows = rows.filter(r => r.origin_peer === peer);
    if (peerRows.length === 0) return;

    logDebug(TAG, `Draining ${peerRows.length} runs for peer ${peer}`);
    for (const { run_id } of peerRows) {
      try {
        await this.pushEvents(run_id, peer);
      } catch (err) {
        logError(TAG, `Failed to drain events for run ${run_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Handle an inbound lifecycle event (origin side).
   */
  async handleInboundEvent(
    _authenticatedPeer: string,
    event: RemotePiEventV1,
    onReduce?: (event: RemotePiEventV1) => Promise<void>
  ): Promise<{ accepted: boolean; reason?: string }> {
    try {
      this._validateEvent(event);

      if (this.deps.localPeerName && event.origin_peer !== this.deps.localPeerName) {
        return { accepted: false, reason: "Event origin_peer does not match local peer" };
      }

      const existing = this.deps.store.getEventsAfter({ runId: event.run_id, afterSequence: event.sequence - 1, limit: 1 }).find(e => e.sequence === event.sequence);
      if (existing) {
        if (existing.content_sha256 !== event.content_sha256) {
          return { accepted: false, reason: "Conflicting event hash" };
        }
        logTrace(TAG, `Ignoring duplicate event ${event.event_id}`);
        return { accepted: true };
      }

      const maxSeq = this.deps.store.getMaxSequence(event.run_id);
      if (event.sequence > maxSeq + 1) {
        logDebug(TAG, `Gap detected for run ${event.run_id}: have ${maxSeq}, got ${event.sequence}`);
      }

      if (onReduce) {
        await onReduce(event);
      }

      const listeners = this.eventListeners.get(event.run_id) || [];
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          logError(TAG, `Event listener error for run ${event.run_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

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
    if (request.version !== 1) {
      return { error: `Unsupported request version: ${request.version}` };
    }

    const limit = Math.min(request.limit ?? this.config.maxCatchUpBatch, REMOTE_PI_BOUNDS.MAX_EVENTS_PER_LIST);

    const run = this.deps.store.get(request.run_id);
    if (!run) {
      return { error: `Run ${request.run_id} not found` };
    }
    if (run.originPeer !== authenticatedPeer) {
      return { error: "Run belongs to a different peer" };
    }

    const events = this.deps.store.getEventsAfter({ runId: request.run_id, afterSequence: request.after_sequence, limit });

    logDebug(TAG, `Listed ${events.length} events for run ${request.run_id} after seq ${request.after_sequence}`);

    const eventEnvelopes = events.map(row => this.deps.eventProducer.buildEventEnvelope(row));

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
    const run = this.deps.store.get(runId);
    if (!run) {
      return { error: `Run ${runId} not found` };
    }
    if (run.originPeer !== authenticatedPeer) {
      return { error: "Run belongs to a different peer" };
    }

    const maxSeq = this.deps.store.getMaxSequence(runId);
    if (sequence > maxSeq) {
      return { error: `Sequence ${sequence} exceeds max sequence ${maxSeq}` };
    }

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

    if (!this.route || !this.route.hasRoute(ownerPeer)) {
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
        // Catch-up uses broker sendRequest (request/response), not sendPush
        const broker = await import("./peer-ws-broker.js").then(m => m.getPeerWsBroker());
        const response = await broker.sendRequest(ownerPeer, "pi.events.list.v1", request) as RemotePiEventsListResponseV1 | { error: string };

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

        if (fetched > 0) {
          await broker.sendRequest(ownerPeer, "pi.events.ack.v1", {
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
    validateEventV1(event);

    const bytes = Buffer.byteLength(JSON.stringify(event), "utf-8");
    if (bytes > REMOTE_PI_BOUNDS.MAX_EVENT_SIZE) {
      throw new Error(`Event exceeds ${REMOTE_PI_BOUNDS.MAX_EVENT_SIZE} bytes`);
    }
  }
}
