/**
 * peer-transport/index.ts — Factory + singleton (#911).
 */

export type { PeerTransport, PeerCard, PeerMessage, TaskResult } from "./interface.js";
export { HttpTransport } from "./http-transport.js";

import { HttpTransport } from "./http-transport.js";
import type { PeerTransport } from "./interface.js";

let _instance: PeerTransport | null = null;

/** Get the singleton PeerTransport instance. */
export function getPeerTransport(): PeerTransport {
  if (!_instance) _instance = new HttpTransport();
  return _instance;
}
