/**
 * openai-compat-translate — pure request/response shape translation (#373).
 *
 * Converts between OpenAI Chat Completions API shape and the internal
 * single-string prompt / single-string reply used by SubagentRuntime +
 * IKiroTransport.
 *
 * Design: pure functions, no I/O. Unit-tested in isolation.
 */

import { randomUUID } from "node:crypto";

// ── OpenAI request shape ────────────────────────────────────────────────────

export type OpenAIRole = "system" | "user" | "assistant" | "tool";

export interface OpenAIMessage {
  role: OpenAIRole;
  content: string | null;
  /** OpenAI tool-call fields — accepted in v1 but not forwarded to the agent. */
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  /** v1: supported shape-wise but just passed to transport where possible. */
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  /** Ignored in v1 (logged at DEBUG). */
  tools?: unknown[];
  tool_choice?: unknown;
}

// ── Untrusted-input parsing (pattern borrowed from openclaw http handlers) ──

/**
 * Raw shape as it arrives over the wire — every field `unknown` until
 * narrowed. Never cast this directly to OpenAIChatRequest; use
 * `validateChatRequest()` instead.
 */
export interface RawOpenAIChatRequest {
  model?: unknown;
  messages?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  top_p?: unknown;
  stream?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  // Allow any other fields (logged + dropped)
  [key: string]: unknown;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; code: string };

/** Narrow a role value to one of the supported OpenAIRoles. */
function asRole(v: unknown): OpenAIRole | null {
  return v === "system" || v === "user" || v === "assistant" || v === "tool" ? v : null;
}

/** Normalize a content value to `string | null` — rejects non-string, non-null. */
function asContent(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v === "string") return v;
  return undefined; // signals "invalid"
}

/** Validate a single `messages[]` entry. Returns error index-tagged. */
function validateMessage(raw: unknown, index: number): ValidationResult<OpenAIMessage> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: `messages[${index}] must be an object`, code: "invalid_message" };
  }
  const m = raw as Record<string, unknown>;
  const role = asRole(m["role"]);
  if (!role) {
    return { ok: false, message: `messages[${index}].role must be one of system/user/assistant/tool`, code: "invalid_role" };
  }
  const content = asContent(m["content"]);
  if (content === undefined) {
    return { ok: false, message: `messages[${index}].content must be a string or null`, code: "invalid_content" };
  }
  const msg: OpenAIMessage = { role, content };
  if (typeof m["name"] === "string") msg.name = m["name"];
  if (typeof m["tool_call_id"] === "string") msg.tool_call_id = m["tool_call_id"];
  if (Array.isArray(m["tool_calls"])) msg.tool_calls = m["tool_calls"];
  return { ok: true, value: msg };
}

/**
 * Validate a raw OpenAI chat completions request body. Returns a narrowed
 * OpenAIChatRequest or a shaped error. This is the ONLY place unknown →
 * typed happens — downstream code trusts the returned shape.
 */
export function validateChatRequest(raw: unknown): ValidationResult<OpenAIChatRequest> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "Request body must be a JSON object", code: "invalid_body" };
  }
  const r = raw as RawOpenAIChatRequest;
  if (!Array.isArray(r.messages) || r.messages.length === 0) {
    return { ok: false, message: "Missing or empty 'messages' array", code: "invalid_messages" };
  }

  const validated: OpenAIMessage[] = [];
  for (let i = 0; i < r.messages.length; i++) {
    const result = validateMessage(r.messages[i], i);
    if (!result.ok) return result;
    validated.push(result.value);
  }

  const out: OpenAIChatRequest = {
    model: typeof r.model === "string" ? r.model : "kp/default",
    messages: validated,
  };
  if (typeof r.temperature === "number") out.temperature = r.temperature;
  if (typeof r.max_tokens === "number") out.max_tokens = r.max_tokens;
  if (typeof r.top_p === "number") out.top_p = r.top_p;
  if (typeof r.stream === "boolean") out.stream = r.stream;
  if (Array.isArray(r.tools)) out.tools = r.tools;
  if (r.tool_choice !== undefined) out.tool_choice = r.tool_choice;
  return { ok: true, value: out };
}

// ── OpenAI response shape ───────────────────────────────────────────────────

export interface OpenAIChatChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter";
}

export interface OpenAIChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatChoice[];
  usage: OpenAIChatUsage;
}

// ── OpenAI error envelope ───────────────────────────────────────────────────

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code?: string;
    param?: string | null;
  };
}

export function openaiError(message: string, type: string, code?: string): OpenAIError {
  const err: OpenAIError["error"] = { message, type };
  if (code !== undefined) err.code = code;
  return { error: err };
}

// ── Translation ─────────────────────────────────────────────────────────────

export interface FlattenedPrompt {
  /** The final user message to send to the agent. */
  prompt: string;
  /** Any client-provided system messages, concatenated. Empty string if none. */
  clientSystem: string;
  /** All message contents in order, for injection scanning. */
  allContents: string[];
}

/**
 * Flatten an OpenAI `messages[]` into a single prompt + system prefix.
 *
 * - System messages: concatenated into `clientSystem` (prepended to prompt on first turn).
 * - Last user message: becomes the prompt.
 * - Assistant/tool messages: ignored (they're context the client has, kiro-cli has its own).
 * - Returns allContents[] for injection scanning.
 */
export function flattenMessages(messages: readonly OpenAIMessage[]): FlattenedPrompt {
  const systemParts: string[] = [];
  const allContents: string[] = [];
  let lastUserContent = "";

  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : "";
    allContents.push(content);
    if (msg.role === "system" && content.trim()) {
      systemParts.push(content.trim());
    } else if (msg.role === "user" && content.trim()) {
      lastUserContent = content; // overwrites — we want the LAST user message
    }
  }

  return {
    prompt: lastUserContent,
    clientSystem: systemParts.join("\n\n"),
    allContents,
  };
}

/**
 * Compose the final prompt that goes to the agent transport.
 * System message (if any) is prefixed with a clear marker so the agent
 * knows it's from the client, not from its own SOUL.
 */
export function composePrompt(flat: FlattenedPrompt): string {
  if (!flat.clientSystem) return flat.prompt;
  return `[CLIENT SYSTEM]\n${flat.clientSystem}\n[END CLIENT SYSTEM]\n\n${flat.prompt}`;
}

/**
 * Build an OpenAI-shaped chat completion response from the agent's reply.
 * `model` echoes the client's request (or default); `usage` ships zeros
 * per plan decision (revisit if a client actually validates values).
 */
export function buildChatResponse(opts: {
  model: string;
  content: string;
  finishReason?: "stop" | "length";
}): OpenAIChatResponse {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: opts.content },
      finish_reason: opts.finishReason ?? "stop",
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, // TODO(#373 v2): token counting
  };
}

// ── Session key extraction ──────────────────────────────────────────────────

/**
 * Extract session key from request headers. Honors `X-Session-Id` for
 * multi-client isolation. Empty/whitespace treated as absent.
 * See plan v5 "Session model" — clients that don't set this share
 * the "default" session and will see context bleed.
 */
export function extractSessionKey(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["x-session-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = (value ?? "").trim();
  return trimmed || "default";
}

// ── Bearer token extraction ─────────────────────────────────────────────────

/**
 * Parse the `Authorization: Bearer <token>` header.
 * Returns the token or null if missing/malformed.
 */
export function extractBearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers["authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== "string") return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : null;
}

// ── Models list (static) ────────────────────────────────────────────────────

export interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export function buildModelsList(): { object: "list"; data: OpenAIModel[] } {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: [
      { id: "kp/default", object: "model", created: now, owned_by: "kp" },
      { id: "kp", object: "model", created: now, owned_by: "kp" },
    ],
  };
}
