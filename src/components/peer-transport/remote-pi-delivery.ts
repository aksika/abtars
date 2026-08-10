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
 * #1358 review — Declared heartbeat budget for `remote-pi-drain`
 * (spec #1358 "Heartbeat budget requirements"). Every bound is enforced in
 * code; a drain that exceeds the per-tick wall clock returns and the backlog
 * is picked up on the next tick.
 */
export const DRAIN_BUDGET = {
  /** Absolute per-tick wall-clock budget, measured from task entry. */
  tickWallClockMs: 5_000,
  /** Max peers touched per tick — round-robin across connected peers. */
  maxPeersPerTick: 4,
  /** Max runs drained per peer per tick. */
  maxRunsPerPeerPerTick: 8,
  /** Max events pushed per run per tick (existing push batch bound). */
  maxEventsPerRunPerTick: 100,
  /** Per-request network timeout, never exceeding remaining tick budget. */
  requestTimeoutMs: 5_000,
} as const;

export interface DrainBudget {
  /** Absolute wall-clock deadline (ms epoch) for this drain pass. */
  deadlineMs: number;
  /** Max runs drained for this peer in this pass. */
  maxRunsPerPeer: number;
  /** Max events pushed per run in this pass. */
  maxEventsPerRun: number;
  /** Per-request network timeout (ms), clamped to the remaining budget. */
  requestTimeoutMs: number;
}

function normalizeBudget(partial?: Partial<DrainBudget>, now: number = Date.now()): DrainBudget {
  return {
    deadlineMs: partial?.deadlineMs ?? now + DRAIN_BUDGET.tickWallClockMs,
    maxRunsPerPeer: partial?.maxRunsPerPeer ?? DRAIN_BUDGET.maxRunsPerPeerPerTick,
    maxEventsPerRun: partial?.maxEventsPerRun ?? DRAIN_BUDGET.maxEventsPerRunPerTick,
    requestTimeoutMs: partial?.requestTimeoutMs ?? DRAIN_BUDGET.requestTimeoutMs,
  };
}

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
   * Without a budget this pushes a single batch (backwards compatible).
   * With a budget it keeps pushing until the run is drained, the per-run
   * event cap is reached, or the deadline expires.
   */
  async pushEvents(runId: string, originPeer: string, budget?: Partial<DrainBudget>): Promise<number> {
    if (!this.route || !this.route.hasRoute(originPeer)) {
      logTrace(TAG, `Cannot push events for run ${runId}: ${originPeer} not connected`);
      if (this.route) {
        this.route.requestConnection(originPeer, "outbox");
      }
      return 0;
    }

    const b = budget ? normalizeBudget(budget) : null;
    let pushed = 0;

    for (;;) {
      if (b && Date.now() >= b.deadlineMs) break;
      const batchLimit = b
        ? Math.min(this.config.maxPushBatch, Math.max(0, b.maxEventsPerRun - pushed))
        : this.config.maxPushBatch;
      if (batchLimit <= 0) break;

      const events = this.deps.store.getUnacknowledgedEvents(runId, batchLimit);
      if (events.length === 0) {
        break;
      }

      logDebug(TAG, `Pushing ${events.length} events for run ${runId} to ${originPeer}`);

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

      // One batch per pass when no budget (legacy behavior); with a budget,
      // keep draining until the run is empty or a bound is hit.
      if (!b || events.length < batchLimit) break;
    }

    return pushed;
  }

  /**
   * Drain pending events for a specific peer (triggered by route-available
   * or the remote-pi-drain heartbeat task).
   *
   * #1358 review — budget rules: at most one drain in flight per peer;
   * OVERLAPPING CALLS ARE SKIPPED, not queued (a second tick never waits on
   * a first one, so it cannot extend its own tick budget). Runs per peer are
   * capped and the deadline is honored; leftover backlog resumes next tick.
   */
  async drainPeer(peer: string, budget?: Partial<DrainBudget>): Promise<void> {
    if (this.drainInFlight.has(peer)) {
      logTrace(TAG, `Drain for peer ${peer} already in flight — skipping overlapping call`);
      return;
    }

    const promise = this._drainPeer(peer, budget);
    this.drainInFlight.set(peer, promise);
    try {
      await promise;
    } finally {
      this.drainInFlight.delete(peer);
    }
  }

  private async _drainPeer(peer: string, budget?: Partial<DrainBudget>): Promise<void> {
    const b = normalizeBudget(budget);
    const rows = this.deps.store.findRunsWithUnacknowledgedEvents();
    const peerRows = rows.filter(r => r.origin_peer === peer).slice(0, b.maxRunsPerPeer);
    if (peerRows.length === 0) return;

    logDebug(TAG, `Draining up to ${peerRows.length} runs for peer ${peer} (deadline ${b.deadlineMs})`);
    for (const { run_id } of peerRows) {
      if (Date.now() >= b.deadlineMs) {
        logTrace(TAG, `Drain budget expired — ${peerRows.length} run(s) for peer ${peer} left for next tick`);
        break;
      }
      try {
        await this.pushEvents(run_id, peer, b);
      } catch (err) {
        logError(TAG, `Failed to drain events for run ${run_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Persisted round-robin drain cursor (remote-pi-drain heartbeat task). */
  getDrainCursor(): number {
    return this.deps.store.getDrainCursor();
  }

  setDrainCursor(value: number): void {
    this.deps.store.setDrainCursor(value);
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
  async catchUp(runId: string, ownerPeer: string, currentCursor: number, onEvent: (event: RemotePiEventV1) => Promise<void>, budget?: Partial<DrainBudget>): Promise<number> {
    const existing = this.activeCatchUp.get(runId);
    if (existing) {
      await existing;
      return 0;
    }

    const catchUpPromise = this._doCatchUp(runId, ownerPeer, currentCursor, onEvent, budget);
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
    onEvent: (event: RemotePiEventV1) => Promise<void>,
    budget?: Partial<DrainBudget>
  ): Promise<number> {
    let fetched = 0;
    let hasMore = true;
    let cursor = currentCursor;
    const deadline = (budget ? normalizeBudget(budget) : normalizeBudget()).deadlineMs;

    logInfo(TAG, `Starting catch-up for run ${runId} from cursor ${cursor}`);

    if (!this.route || !this.route.hasRoute(ownerPeer)) {
      logError(TAG, `Cannot catch-up: ${ownerPeer} not connected`);
      return 0;
    }

    while (hasMore && fetched < REMOTE_PI_BOUNDS.MAX_EVENTS_PER_LIST * 10 && Date.now() < deadline) {
      const request: RemotePiEventsListRequestV1 = {
        version: 1,
        run_id: runId,
        after_sequence: cursor,
        limit: this.config.maxCatchUpBatch,
      };

      try {
        // Catch-up uses broker sendRequest (request/response), not sendPush
        const broker = await import("./peer-ws-broker.js").then(m => m.getPeerWsBroker());
        // #1358 review — per-request network timeout, clamped to the
        // remaining drain budget; a hung peer consumes only its own share.
        const timeoutMs = Math.max(1, Math.min(DRAIN_BUDGET.requestTimeoutMs, deadline - Date.now()));
        const response = await withTimeout(
          broker.sendRequest(ownerPeer, "pi.events.list.v1", request),
          timeoutMs,
        ) as RemotePiEventsListResponseV1 | { error: string };

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
          await withTimeout(
            broker.sendRequest(ownerPeer, "pi.events.ack.v1", {
              version: 1,
              run_id: runId,
              sequence: cursor,
            } as RemotePiEventsAckRequestV1),
            Math.max(1, Math.min(DRAIN_BUDGET.requestTimeoutMs, deadline - Date.now())),
          );
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

/**
 * Race a promise against a timeout. Rejects with a bounded message when the
 * deadline expires; the underlying promise is left to settle on its own.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Peer request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
