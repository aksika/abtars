/**
 * peer-resolver.ts — #1520: one exact enrolled-peer name resolver used by every
 * peer egress tool (peer_session, peer_doorbell, and future egress).
 *
 * Peer names are accepted only as exact keys from peers.json; case folding and
 * aliases are forbidden. All local session labels/names (O, Orc, orc, and every
 * SessionType label) are rejected BEFORE any config lookup or transport call
 * with routing/local_session_not_peer. Unknown external names keep the
 * routing/peer_not_enrolled classification.
 */
import { loadPeerConfig, type PeerConfig } from "../peer-config.js";
import { typeLabel } from "../spin-types.js";
import type { SessionType } from "../spin-types.js";

export type PeerResolution =
  | { ok: true; peer: string }
  | { ok: false; code: "local_session_not_peer" | "peer_not_enrolled"; message: string };

const LOCAL_SESSION_TYPES: readonly SessionType[] = ["A", "B", "C", "T", "P", "S", "O", "W", "D", "H", "K"];

function localNames(): Set<string> {
  const names = new Set<string>(["O", "Orc", "orc", "ORC", "self", "master"]);
  for (const t of LOCAL_SESSION_TYPES) {
    names.add(t);
    names.add(typeLabel(t));
    names.add(t.toLowerCase());
    names.add(typeLabel(t).toLowerCase());
  }
  return names;
}

const _local = localNames();

export function isLocalSessionName(name: string): boolean {
  return _local.has(name);
}

/** Resolve a raw peer name to an exact enrolled key with no transport access. */
export function resolvePeerName(name: string, config?: PeerConfig): PeerResolution {
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    return { ok: false, code: "peer_not_enrolled", message: "peer name is required" };
  }
  if (isLocalSessionName(trimmed)) {
    return { ok: false, code: "local_session_not_peer", message: `${trimmed} is a local session identity, not a remote peer` };
  }
  const cfg = config ?? loadPeerConfig();
  if (cfg.self.name === trimmed) {
    return { ok: false, code: "local_session_not_peer", message: `${trimmed} is this machine's own identity, not a peer` };
  }
  if (!cfg.peers[trimmed]) {
    return { ok: false, code: "peer_not_enrolled", message: `Unknown peer: ${trimmed}` };
  }
  return { ok: true, peer: trimmed };
}
