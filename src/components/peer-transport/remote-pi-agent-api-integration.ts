/**
 * peer-transport/remote-pi-agent-api-integration.ts — Agent API routes for remote Pi (#1358).
 *
 * Provides HTTP endpoints and WebSocket handlers for remote Pi lifecycle
 * events and control commands.
 */

import type {
  RemotePiEventV1,
  RemotePiEventsListRequestV1,
  RemotePiEventsListResponseV1,
  RemotePiEventsAckRequestV1,
  RemotePiEventsAckResponseV1,
  RemotePiControlRequestV1,
  RemotePiControlResponseV1,
  ControlErrorCode,
} from "./remote-pi-types.js";
import {
  validateEventV1,
  createControlError,
  REMOTE_PI_BOUNDS,
} from "./remote-pi-types.js";
import type { RemotePiEventProducer } from "./remote-pi-event-producer.js";
import type { RemotePiControlHandler } from "./remote-pi-control-handler.js";
import type { RemotePiDeliveryManager } from "./remote-pi-delivery.js";
import type { RemotePiOriginReducer } from "./remote-pi-origin-projection.js";
import { logError, logTrace } from "../logger.js";

const TAG = "remote-pi-api";

export interface RemotePiApiDeps {
  /** Owner-side event producer */
  eventProducer?: RemotePiEventProducer;
  /** Owner-side control handler */
  controlHandler?: RemotePiControlHandler;
  /** Owner-side delivery manager */
  deliveryManager?: RemotePiDeliveryManager;
  /** Origin-side projection reducer */
  originReducer?: RemotePiOriginReducer;
  /** Local peer name (for origin-side ownership checks) */
  localPeerName?: string;
}

/**
 * Handler for POST /v1/pi-events/push (origin side).
 *
 * The authenticated peer is the OWNER who is pushing the event to us.
 * The event's origin_peer field identifies who the event is FOR (us).
 * So we verify: event.origin_peer === localPeerName.
 */
export async function handlePushLifecycleEvent(
  deps: RemotePiApiDeps,
  _authenticatedPeer: string,
  event: RemotePiEventV1
): Promise<{ success: boolean; error?: string }> {
  if (!deps.originReducer) {
    return { success: false, error: "Origin reducer not available" };
  }

  try {
    // Validate event (includes hash verification)
    validateEventV1(event);

    // Verify this event is addressed to us (the origin).
    // The owner pushes events whose origin_peer === our local peer name.
    // authenticatedPeer is the owner; they need NOT match origin_peer.
    if (deps.localPeerName && event.origin_peer !== deps.localPeerName) {
      return { success: false, error: "Event origin_peer does not match local peer" };
    }

    // Check payload size
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf-8");
    if (bytes > REMOTE_PI_BOUNDS.MAX_EVENT_SIZE) {
      return { success: false, error: `Event exceeds ${REMOTE_PI_BOUNDS.MAX_EVENT_SIZE} bytes` };
    }

    // Reduce into local projection
    const accepted = deps.originReducer.reduce(event);
    if (!accepted) {
      logTrace(TAG, `Rejected event ${event.event_id} for run ${event.run_id}`);
      return { success: false, error: "Event rejected by reducer" };
    }
    logTrace(TAG, `Accepted event ${event.event_id} for run ${event.run_id}`);

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(TAG, `Error in handlePushLifecycleEvent: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Handler for GET /v1/pi-runs/:runId/events (owner side).
 */
export async function handleListRemotePiEvents(
  deps: RemotePiApiDeps,
  authenticatedPeer: string,
  runId: string,
  afterSequence: number,
  limit: number
): Promise<RemotePiEventsListResponseV1 | { error: string }> {
  if (!deps.deliveryManager) {
    return { error: "Delivery manager not available" };
  }

  if (!deps.deliveryManager.listEvents) {
    return { error: "listEvents not available on delivery manager" };
  }

  const request: RemotePiEventsListRequestV1 = {
    version: 1,
    run_id: runId,
    after_sequence: afterSequence,
    limit,
  };

  return deps.deliveryManager.listEvents(request, authenticatedPeer);
}

/**
 * Handler for POST /v1/pi-runs/:runId/events/acknowledge (owner side).
 */
export async function handleAcknowledgeRemotePiEvents(
  deps: RemotePiApiDeps,
  authenticatedPeer: string,
  runId: string,
  sequence: number
): Promise<RemotePiEventsAckResponseV1 | { error: string }> {
  if (!deps.deliveryManager) {
    return { error: "Delivery manager not available" };
  }

  return deps.deliveryManager.acknowledgeEvent(authenticatedPeer, runId, sequence);
}

/**
 * Handler for POST /v1/pi-runs/:runId/control (owner side).
 */
export async function handleRemotePiControl(
  deps: RemotePiApiDeps,
  authenticatedPeer: string,
  principalId: string,
  _request: RemotePiControlRequestV1
): Promise<RemotePiControlResponseV1> {
  if (!deps.controlHandler) {
    return createControlError(
      _request.command_id,
      "INTERNAL_ERROR",
      "Control handler not available"
    );
  }

  return deps.controlHandler.handleControlRequest(
    { peerName: authenticatedPeer, principalId },
    _request
  );
}

/**
 * WebSocket method: pi.lifecycle.v1 (push event).
 */
export async function wsHandlePiLifecycleV1(
  deps: RemotePiApiDeps,
  authenticatedPeer: string,
  payload: unknown
): Promise<{ success: boolean; error?: string }> {
  const event = payload as RemotePiEventV1;
  return handlePushLifecycleEvent(deps, authenticatedPeer, event);
}

/**
 * WebSocket method: pi.events.list.v1 (catch-up).
 */
export async function wsHandlePiEventsListV1(
  deps: RemotePiApiDeps,
  authenticatedPeer: string,
  payload: unknown
): Promise<RemotePiEventsListResponseV1 | { error: string }> {
  const request = payload as RemotePiEventsListRequestV1;
  return handleListRemotePiEvents(
    deps,
    authenticatedPeer,
    request.run_id,
    request.after_sequence,
    request.limit ?? 100
  );
}

/**
 * WebSocket method: pi.events.ack.v1 (acknowledge).
 */
export async function wsHandlePiEventsAckV1(
  deps: RemotePiApiDeps,
  authenticatedPeer: string,
  payload: unknown
): Promise<RemotePiEventsAckResponseV1 | { error: string }> {
  const request = payload as RemotePiEventsAckRequestV1;
  return handleAcknowledgeRemotePiEvents(
    deps,
    authenticatedPeer,
    request.run_id,
    request.sequence
  );
}

/**
 * WebSocket method: pi.control.v1 (control command).
 */
export async function wsHandlePiControlV1(
  deps: RemotePiApiDeps,
  authenticatedPeer: string,
  principalId: string,
  payload: unknown
): Promise<RemotePiControlResponseV1> {
  const request = payload as RemotePiControlRequestV1;
  return handleRemotePiControl(deps, authenticatedPeer, principalId, request);
}

/**
 * Helper to write JSON error response.
 */
export function writeJsonError(res: any, statusCode: number, code: ControlErrorCode, message: string, details?: Record<string, unknown>): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: { code, message, details },
  }));
}

/**
 * Helper to write JSON success response.
 */
export function writeJsonSuccess(res: any, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Extract principal ID from peer entry.
 */
export function getPeerPrincipalId(peerName: string): string {
  const { loadPeerConfig } = require("../peer-config.js") as typeof import("../peer-config.js");
  const config = loadPeerConfig();
  const entry = config.peers[peerName];
  if (!entry) {
    throw new Error(`Peer '${peerName}' not found`);
  }
  // Principal ID is derived from peer name for peer authentication
  return `peer:${peerName}`;
}