/**
 * peer-transport/remote-pi-registry.ts — Singleton registry for #1358 components.
 *
 * Provides accessors for the lifecycle event producer, delivery manager,
 * origin reducer, and control handler. Boot constructs and sets them;
 * other code (PiExecutor hooks, agent-api routes, WSS dispatchers) reads them.
 */

import type { RemotePiEventProducer } from "./remote-pi-event-producer.js";
import type { RemotePiDeliveryManager } from "./remote-pi-delivery.js";
import type { RemotePiOriginReducer } from "./remote-pi-origin-projection.js";
import type { RemotePiControlHandler } from "./remote-pi-control-handler.js";

let _producer: RemotePiEventProducer | null = null;
let _delivery: RemotePiDeliveryManager | null = null;
let _originReducer: RemotePiOriginReducer | null = null;
let _controlHandler: RemotePiControlHandler | null = null;

export function setRemotePiComponents(deps: {
  eventProducer?: RemotePiEventProducer;
  delivery?: RemotePiDeliveryManager;
  originReducer?: RemotePiOriginReducer;
  controlHandler?: RemotePiControlHandler;
}): void {
  if (deps.eventProducer !== undefined) _producer = deps.eventProducer;
  if (deps.delivery !== undefined) _delivery = deps.delivery;
  if (deps.originReducer !== undefined) _originReducer = deps.originReducer;
  if (deps.controlHandler !== undefined) _controlHandler = deps.controlHandler;
}

export function getRemotePiProducer(): RemotePiEventProducer | null {
  return _producer;
}

export function getRemotePiDelivery(): RemotePiDeliveryManager | null {
  return _delivery;
}

export function getRemotePiOriginReducer(): RemotePiOriginReducer | null {
  return _originReducer;
}

export function getRemotePiControlHandler(): RemotePiControlHandler | null {
  return _controlHandler;
}
