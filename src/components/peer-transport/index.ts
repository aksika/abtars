/**
 * peer-transport/index.ts — Factory + singleton (#911).
 */

export type { PeerTransport, PeerCard, PeerMessage, PeerHelpTransport, PeerHealth } from "./interface.js";
export { HttpTransport } from "./http-transport.js";
export { startGossipListener, gossipBroadcast, getAlivePeers, getPeerTable, setGossipInterval, stopGossipListener } from "./gossip.js";
export { getHealthStore, getLocalSnapshot, buildSignedStatus, CapabilityRegistry } from "./peer-health.js";

import { HttpTransport } from "./http-transport.js";

let _instance: HttpTransport | null = null;

/** Get the singleton PeerTransport instance. */
export function getPeerTransport(): HttpTransport {
  if (!_instance) _instance = new HttpTransport();
  return _instance;
}

/** Initialize peer transport + WS outbound connections. Call at boot. */
export async function initPeerTransport(): Promise<void> {
  const transport = getPeerTransport() as HttpTransport;
  await transport.initWsConnections();
}
