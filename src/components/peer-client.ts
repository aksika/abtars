/**
 * peer-client.ts — broker-backed client for peer_session chat (#392, #1786).
 *
 * Lane-1 quick chat rides the authenticated WS broker (`peer.chat.v1`,
 * ephemeral — no outbox, no retry). The pre-broker direct TLS dial to
 * peer.host:port is retired: it cannot traverse asymmetric firewalls and
 * races connection management. No route → explicit unavailable error.
 */

import { loadPeerConfig } from "./peer-config.js";
import { resolvePeerName } from "./transport/peer-resolver.js";
import { logInfo } from "./logger.js";

const TAG = "peer-client";

export type PeerError =
  | "timeout" | "unreachable" | "hop_exceeded" | "auth_failed" | "peer_error" | "unknown_peer"
  | "unavailable" | "busy" | "session_expired" | "session_busy" | "invalid_request";

/**
 * Module-level hop budget for the current request. Set by agent-api-server
 * before dispatching a prompt that came with X-Peer-Hops. Retained for the
 * HTTP ingress path; broker chat carries no relay budget (direct route only).
 */
let _currentHops: number | null = null;
export function setCurrentPeerHops(hops: number | null): void { _currentHops = hops; }
export function getCurrentPeerHops(): number | null { return _currentHops; }

export class PeerCallError extends Error {
  constructor(public readonly code: PeerError, message: string) {
    super(message);
    this.name = "PeerCallError";
  }
}

export interface PeerChatCallOptions {
  sessionId?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  timeoutMs?: number;
}

/**
 * Chat with a peer over the WS broker (`peer.chat.v1`).
 * @param peerName — key in peers.json
 * @param prompt — user message (used when `messages` is omitted)
 * @param _hops — legacy relay budget, unused on direct broker routes
 */
export async function callPeer(
  peerName: string,
  prompt: string,
  _hops: number,
  opts?: PeerChatCallOptions,
): Promise<string> {
  const config = loadPeerConfig();
  const resolved = resolvePeerName(peerName, config);
  if (!resolved.ok) throw new PeerCallError("unknown_peer", `${resolved.code}: ${resolved.message}`);
  peerName = resolved.peer;

  const { getPeerWsBroker } = await import("./peer-transport/peer-ws-broker.js");
  const { parsePeerChatResponse } = await import("./peer-transport/peer-chat.js");
  const broker = getPeerWsBroker();

  const timeoutMs = Math.min(opts?.timeoutMs ?? config.timeoutMs ?? 60_000, 120_000);
  const deadlineAt = Date.now() + timeoutMs;
  const messages = opts?.messages ?? [{ role: "user" as const, content: prompt }];
  const sessionId = opts?.sessionId ?? `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const start = Date.now();
  try {
    const raw = await broker.sendEphemeralRequest<unknown>(peerName, "peer.chat.v1", {
      version: 1,
      session_id: sessionId,
      messages,
      deadline_at: deadlineAt,
    }, { timeoutMs });
    const parsed = parsePeerChatResponse(raw);
    if (!parsed.ok) throw new PeerCallError("peer_error", `Peer returned malformed chat response: ${parsed.detail}`);
    logInfo(TAG, `PEER_CALL ${peerName} — chat ${messages.length} msg → ${parsed.response.text.length}ch (${Date.now() - start}ms)`);
    return parsed.response.text;
  } catch (err) {
    throw toPeerCallError(peerName, err);
  }
}

function toPeerCallError(peerName: string, err: unknown): PeerCallError {
  if (err instanceof PeerCallError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith("unavailable")) return new PeerCallError("unavailable", message);
  if (message.startsWith("busy")) return new PeerCallError("busy", message);
  if (message.startsWith("timeout")) return new PeerCallError("timeout", `Peer '${peerName}' timed out (${message})`);
  if (message.startsWith("invalid_request")) return new PeerCallError("invalid_request", message);
  return new PeerCallError("peer_error", message);
}
