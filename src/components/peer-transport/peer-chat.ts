/**
 * peer-chat.ts — Typed `peer.chat.v1` contract (#1786, lane 1 quick chat).
 *
 * Caller-selected discussion lane: plain Q&A / follow-up turns with no
 * durable work (no card, contract, Orc run, or contribution). Transport
 * reachability and request length must never choose the lane.
 *
 * Bounds mirror the broker envelope plus chat-specific caps:
 * - session_id: existing 128-char wire-token convention
 * - messages: user/assistant only, must end in user, max 20 per request
 * - serialized body: 64 KiB; response text: 64 KiB
 */

export const PEER_CHAT_METHOD = "peer.chat.v1" as const;

export const PEER_CHAT_MAX_MESSAGES = 20;
export const PEER_CHAT_MAX_BODY_BYTES = 65_536;
export const PEER_CHAT_MAX_RESPONSE_BYTES = 65_536;
export const PEER_CHAT_MAX_SESSION_ID_BYTES = 128;

const WIRE_TOKEN_RE = /^[A-Za-z0-9._:-]+$/;

export interface PeerChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PeerChatRequestV1 {
  version: 1;
  session_id: string;
  messages: PeerChatMessage[];
  deadline_at: number;
}

export interface PeerChatResponseV1 {
  version: 1;
  text: string;
}

export type PeerChatErrorCode =
  | "invalid_request"
  | "auth_failed"
  | "unavailable"
  | "busy"
  | "timeout"
  | "empty_response"
  | "handler_error";

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export type PeerChatParseResult =
  | { ok: true; request: PeerChatRequestV1 }
  | { ok: false; code: "invalid_request"; detail: string };

/**
 * Strict validation of an already-authenticated chat payload. Runs after the
 * broker's signature/nonce pipeline — never before authentication.
 */
export function parsePeerChatRequest(payload: unknown): PeerChatParseResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "invalid_request", detail: "payload must be an object" };
  }
  const p = payload as Record<string, unknown>;
  if (p.version !== 1) return { ok: false, code: "invalid_request", detail: "unsupported version" };
  if (
    typeof p.session_id !== "string" ||
    p.session_id.length === 0 ||
    utf8Bytes(p.session_id) > PEER_CHAT_MAX_SESSION_ID_BYTES ||
    !WIRE_TOKEN_RE.test(p.session_id)
  ) {
    return { ok: false, code: "invalid_request", detail: "invalid session_id" };
  }
  if (!Array.isArray(p.messages) || p.messages.length === 0 || p.messages.length > PEER_CHAT_MAX_MESSAGES) {
    return { ok: false, code: "invalid_request", detail: "messages must be 1-20 entries" };
  }
  for (const m of p.messages) {
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      return { ok: false, code: "invalid_request", detail: "message must be an object" };
    }
    const mm = m as Record<string, unknown>;
    if (mm.role !== "user" && mm.role !== "assistant") {
      return { ok: false, code: "invalid_request", detail: "message role must be user|assistant" };
    }
    if (typeof mm.content !== "string" || mm.content.length === 0) {
      return { ok: false, code: "invalid_request", detail: "message content must be non-empty text" };
    }
  }
  const last = p.messages[p.messages.length - 1] as PeerChatMessage;
  if (last.role !== "user") {
    return { ok: false, code: "invalid_request", detail: "messages must end in a user turn" };
  }
  if (typeof p.deadline_at !== "number" || !Number.isFinite(p.deadline_at) || p.deadline_at <= 0) {
    return { ok: false, code: "invalid_request", detail: "invalid deadline_at" };
  }
  return {
    ok: true,
    request: {
      version: 1,
      session_id: p.session_id as string,
      messages: p.messages as PeerChatMessage[],
      deadline_at: p.deadline_at as number,
    },
  };
}

export type PeerChatResponseParseResult =
  | { ok: true; response: PeerChatResponseV1 }
  | { ok: false; code: "invalid_request"; detail: string };

export function parsePeerChatResponse(payload: unknown): PeerChatResponseParseResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, code: "invalid_request", detail: "payload must be an object" };
  }
  const p = payload as Record<string, unknown>;
  if (p.version !== 1) return { ok: false, code: "invalid_request", detail: "unsupported version" };
  if (typeof p.text !== "string" || p.text.length === 0 || utf8Bytes(p.text) > PEER_CHAT_MAX_RESPONSE_BYTES) {
    return { ok: false, code: "invalid_request", detail: "invalid text" };
  }
  return { ok: true, response: { version: 1, text: p.text } };
}
