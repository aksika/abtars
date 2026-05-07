/**
 * peer-sessions.ts — in-memory multi-turn peer chat sessions (#428).
 * Sessions expire after 5 min idle. Max 10 turns. No persistence.
 */

export interface PeerChatSession {
  id: string;
  peerName: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  createdAt: number;
  lastActivityAt: number;
}

const sessions = new Map<string, PeerChatSession>();
const MAX_TURNS = 10;
const TTL_MS = 5 * 60 * 1000;

export function getOrCreateSession(sessionId: string | undefined, peerName: string): PeerChatSession {
  if (sessionId && sessions.has(sessionId)) {
    const s = sessions.get(sessionId)!;
    s.lastActivityAt = Date.now();
    return s;
  }
  const id = sessionId ?? `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const session: PeerChatSession = { id, peerName, messages: [], createdAt: Date.now(), lastActivityAt: Date.now() };
  sessions.set(id, session);
  return session;
}

export function addTurn(session: PeerChatSession, role: "user" | "assistant", content: string): void {
  session.messages.push({ role, content });
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
    if (now - s.lastActivityAt > TTL_MS) { sessions.delete(id); cleaned++; }
  }
  return cleaned;
}
