/**
 * peer-sessions.ts — requester-owned multi-turn peer chat sessions (#428, #1786).
 *
 * Sessions expire after 5 min idle. Max 10 turns (20 messages). No persistence.
 *
 * #1786: the store key binds the authenticated local caller AND the canonical
 * destination peer — a session_id alone addresses nothing. Reuse across either
 * boundary is rejected before anything is sent. Unknown/expired supplied IDs
 * return session_expired; only omission allocates. Expiry is evaluated lazily
 * on lookup (no heartbeat task). One in-flight turn per conversation.
 */

export interface PeerChatSession {
  id: string;
  peerName: string;
  /** Authenticated local caller identity (tool context userId). */
  callerId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  createdAt: number;
  lastActivityAt: number;
  inFlight: boolean;
}

const sessions = new Map<string, PeerChatSession>();
const MAX_TURNS = 10;
const TTL_MS = 5 * 60 * 1000;

export type SessionLookup =
  | { ok: true; session: PeerChatSession }
  | { ok: false; code: "session_expired" | "session_mismatch"; message: string };

function isExpired(s: PeerChatSession, now: number): boolean {
  return now - s.lastActivityAt > TTL_MS;
}

/**
 * Look up a caller-owned conversation, or allocate one when no ID is given.
 * Expired rows are collected on lookup.
 */
export function getOrCreateSession(
  sessionId: string | undefined,
  peerName: string,
  callerId: string,
): SessionLookup {
  const now = Date.now();
  if (sessionId) {
    const s = sessions.get(sessionId);
    if (!s || isExpired(s, now)) {
      if (s) sessions.delete(sessionId);
      return { ok: false, code: "session_expired", message: `Unknown or expired peer session: ${sessionId}` };
    }
    if (s.peerName !== peerName || s.callerId !== callerId) {
      return {
        ok: false,
        code: "session_mismatch",
        message: "Peer session may not be reused across peers or callers",
      };
    }
    s.lastActivityAt = now;
    return { ok: true, session: s };
  }
  const id = `pc-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const session: PeerChatSession = {
    id, peerName, callerId, messages: [], createdAt: now, lastActivityAt: now, inFlight: false,
  };
  sessions.set(id, session);
  return { ok: true, session };
}

export function addTurn(session: PeerChatSession, role: "user" | "assistant", content: string): void {
  session.messages.push({ role, content });
  session.lastActivityAt = Date.now();
}

/**
 * Serialize turns: at most one in-flight turn per conversation. Returns false
 * when a turn is already running (caller reports session_busy). Always pair
 * with endTurn on every exit path.
 */
export function tryBeginTurn(session: PeerChatSession): boolean {
  if (session.inFlight) return false;
  session.inFlight = true;
  session.lastActivityAt = Date.now();
  return true;
}

export function endTurn(session: PeerChatSession): void {
  session.inFlight = false;
  session.lastActivityAt = Date.now();
}

export function isEnded(session: PeerChatSession, response: string): { ended: boolean; reason?: string } {
  if (/\[NO-REPLY\]/i.test(response) || /\[END\]/i.test(response)) return { ended: true, reason: "peer-signal" };
  if (session.messages.length >= MAX_TURNS * 2) return { ended: true, reason: "max-turns" };
  return { ended: false };
}

export function destroySession(id: string): void {
  sessions.delete(id);
}

// Cleanup expired sessions (called from heartbeat or lazily)
export function cleanupExpired(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, s] of sessions) {
    if (isExpired(s, now)) { sessions.delete(id); cleaned++; }
  }
  return cleaned;
}
