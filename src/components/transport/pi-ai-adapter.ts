/**
 * pi-ai adapter — the L1 "motor prosthetic" for DirectApiTransport (#1311).
 *
 * Anatomy: pi-ai attaches at Brain (model-transport motor) only. This module
 * takes an abtars candidate {endpoint, apiKey, model, apiFormat} + conversation
 * and executes ONE streamed completion through pi-ai, translating pi-ai stream
 * events into abtars's internal SSEEvent contract. It does NOT touch pi-ai's
 * model catalog — the single pi Model is constructed FROM the candidate via
 * createProvider (Phase 1 boundary: catalog adoption is a later task).
 *
 * Resilience contract (downward-only):
 *   - L1 executes one call; it does not rotate or retry. pi-ai is called with
 *     maxRetries: 0 — abtars L2 (fallback-policy) owns the retry budget.
 *   - If pi-ai cannot be loaded, streamPiAiCompletion throws PiAiUnavailableError;
 *     the gate catches it and falls through to the L0 reptile floor.
 *   - Request errors (provider down, quota, auth) are mapped to an Error whose
 *     message carries "API error <status>" so sendWithPolicy's existing
 *     parseErrorStatus/classifyError/parseRetryAfter classify them unchanged.
 *
 * Compile-time pi-free: this file never `import type`s from @earendil-works/pi-ai
 * (it is not a dependency). The Pi* interfaces below mirror pi-ai's shapes
 * structurally; the real module is loaded dynamically at runtime via lazyRequire.
 */

import { lazyRequire } from "../../utils/lazy-require.js";
import { logWarn } from "../logger.js";
import { parseRetryAfter, parseUsageLimitCooldown } from "./transport-utils.js";
import type { ErrorKind } from "./model-health-registry.js";
import type { SSEEvent } from "./sse-parser.js";
import type { ChatMessage, ContentPart } from "./conversation-session.js";

const TAG = "pi-ai-adapter";

// ─── abtars-side input types ────────────────────────────────────────────────

export type ApiFormat = "chat" | "responses" | "anthropic";

/** An abtars tool schema in OpenAI function-tool shape (getToolSchemas output). */
export type OpenAiToolSchema = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** The active candidate L2 selected — exactly what L0 would call with. */
export interface PiAiCandidate {
  model: string;
  endpoint: string;
  apiKey?: string;
  apiFormat?: ApiFormat;
  maxOutput: number;
  thinking?: { style: "effort"; default: string } | { style: "extended"; default: number };
  /** Session-level reasoning override (from /reasoning). */
  reasoningEffort?: "low" | "medium" | "high" | null;
  /** Session key — used as pi's sessionId for prompt-cache affinity. */
  sessionId?: string;
}

export interface PiAiConversation {
  messages: ChatMessage[];
  tools: OpenAiToolSchema[];
}

// ─── pi-ai structural types (compile-time pi-free; structurally compatible) ─

/** The pi Api families abtars's DirectApi path can target. */
export type PiApi = "openai-completions" | "openai-responses" | "anthropic-messages" | (string & {});

export type PiThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface PiTextContent { type: "text"; text: string }
interface PiThinkingContent { type: "thinking"; thinking: string }
interface PiToolCallContent { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
interface PiImageContent { type: "image"; data: string; mimeType: string }
type PiContentBlock = PiTextContent | PiThinkingContent | PiToolCallContent;

interface PiAssistantMessage {
  role: "assistant";
  content: PiContentBlock[];
  usage: PiUsage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
}

type PiAssistantMessageEvent =
  | { type: "text_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: PiAssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: PiToolCallContent; partial: PiAssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: PiAssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: PiAssistantMessage };

/** Subset of pi-ai's Model<TApi> that the api stream functions read. */
export interface PiModel {
  id: string;
  name: string;
  api: PiApi;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
}

/** pi-ai ProviderStreams: every api module exports exactly { stream, streamSimple }. */
export interface PiProviderStreams {
  stream(model: PiModel, context: PiContext, options?: Record<string, unknown>): AsyncIterable<PiAssistantMessageEvent>;
  streamSimple(model: PiModel, context: PiContext, options?: Record<string, unknown>): AsyncIterable<PiAssistantMessageEvent>;
}

interface PiContext {
  systemPrompt?: string;
  messages: PiMessage[];
  tools?: PiTool[];
}

type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;
interface PiUserMessage { role: "user"; content: string | (PiTextContent | PiImageContent)[]; timestamp: number }
interface PiToolResultMessage { role: "toolResult"; toolCallId: string; toolName: string; content: PiTextContent[]; isError: boolean; timestamp: number }
interface PiTool { name: string; description: string; parameters: Record<string, unknown> }

/** The pi-ai root module surface this adapter uses. */
export interface PiAiModule {
  createProvider(input: Record<string, unknown>): { streamSimple(model: PiModel, context: PiContext, options?: Record<string, unknown>): AsyncIterable<PiAssistantMessageEvent> };
  isRetryableAssistantError(message: PiAssistantMessage): boolean;
}

// ─── error tagging ──────────────────────────────────────────────────────────

/**
 * Tagged load failure. The gate catches this (by name) and falls through to L0.
 * Request errors are NOT this — they throw a plain Error with "API error <status>".
 */
export class PiAiUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PiAiUnavailableError";
  }
}

// ─── pure translators ───────────────────────────────────────────────────────

/** Map abtars apiFormat → pi Api family. chat/undefined → openai-completions. */
export function pickPiApi(apiFormat?: ApiFormat): PiApi {
  if (apiFormat === "responses") return "openai-responses";
  if (apiFormat === "anthropic") return "anthropic-messages";
  return "openai-completions";
}

const EFFORT_LEVELS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh"];

function mapEffortLevel(s: string | undefined): PiThinkingLevel | undefined {
  if (!s) return undefined;
  return EFFORT_LEVELS.includes(s) ? (s as PiThinkingLevel) : "medium";
}

/** Derive a stable provider id from the endpoint host (cosmetic; pi uses it for logging). */
function deriveProviderId(endpoint: string): string {
  try {
    const host = new URL(endpoint).hostname;
    const id = host.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return id || "abtars-direct";
  } catch {
    return "abtars-direct";
  }
}

function conversationHasImage(messages: ChatMessage[]): boolean {
  return messages.some(m => Array.isArray(m.content) && m.content.some(p => (p as ContentPart)?.type === "image_url"));
}

/**
 * Resolve the reasoning level to pass to pi, given abtars config.
 *
 * Phase 1 parity note: abtars's DirectApi path only emits reasoning params on the
 * completions branch today (responses/anthropic adapters take no thinking arg).
 * We mirror that — reasoning is enabled only when an effort level is available
 * (session override or effort-style thinking config). Extended-budget style and
 * the responses/anthropic paths defer reasoning to the bake (later task).
 */
export function resolveReasoning(candidate: PiAiCandidate): { reasoning: boolean; level: PiThinkingLevel | undefined } {
  const level = candidate.reasoningEffort
    ?? (candidate.thinking?.style === "effort" ? mapEffortLevel(candidate.thinking.default) : undefined);
  return { reasoning: level !== undefined, level };
}

/**
 * Construct a single pi Model FROM the abtars candidate (not from pi's catalog).
 * contextWindow is unknown to abtars at the transport seam — compaction math
 * stays with L2 (agent-registry), so 0 here is correct for the motor path.
 */
export function buildPiModel(candidate: PiAiCandidate, api: PiApi, hasImage: boolean, providerId: string): PiModel {
  const { reasoning } = resolveReasoning(candidate);
  return {
    id: candidate.model,
    name: candidate.model,
    api,
    provider: providerId,
    baseUrl: candidate.endpoint,
    reasoning,
    input: hasImage ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: candidate.maxOutput,
  };
}

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/s;

function toPiUserContent(content: string | ContentPart[] | null): string | (PiTextContent | PiImageContent)[] {
  if (typeof content === "string" || content === null) return content ?? "";
  const parts: (PiTextContent | PiImageContent)[] = [];
  for (const p of content) {
    if (p.type === "text") parts.push({ type: "text", text: p.text });
    else {
      const m = DATA_URL_RE.exec(p.image_url.url);
      if (m) parts.push({ type: "image", data: m[2] as string, mimeType: m[1] as string });
      else logWarn(TAG, `Non-data-URL image not supported on pi-ai path; skipping`);
    }
  }
  return parts;
}

function parseArgsObject(argsStr: string): Record<string, unknown> {
  try { return JSON.parse(argsStr) as Record<string, unknown>; } catch { return {}; }
}

/**
 * Translate an abtars ChatMessage[] conversation → pi Context.
 * system messages collapse into systemPrompt; assistant tool_calls become pi
 * toolCall content blocks (arguments parsed to objects); tool messages become
 * pi toolResult messages.
 */
export function buildPiContext(conv: PiAiConversation): PiContext {
  const systemParts: string[] = [];
  const messages: PiMessage[] = [];
  const now = Date.now();

  for (const m of conv.messages) {
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      messages.push({ role: "user", content: toPiUserContent(m.content), timestamp: now });
    } else if (m.role === "assistant") {
      const blocks: PiContentBlock[] = [];
      if (typeof m.content === "string" && m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ type: "toolCall", id: tc.id, name: tc.function.name, arguments: parseArgsObject(tc.function.arguments) });
      }
      messages.push({ role: "assistant", content: blocks, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: (m.tool_calls?.length ? "toolUse" : "stop"), errorMessage: undefined } as PiAssistantMessage);
    } else if (m.role === "tool") {
      const text = typeof m.content === "string" ? m.content : "";
      messages.push({ role: "toolResult", toolCallId: m.tool_call_id ?? "", toolName: m.name ?? "", content: [{ type: "text", text }], isError: false, timestamp: now });
    }
  }

  const tools: PiTool[] | undefined = conv.tools.length
    ? conv.tools.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters }))
    : undefined;

  return { systemPrompt: systemParts.join("\n\n") || undefined, messages, tools };
}

/**
 * Translate a pi-ai AssistantMessageEvent stream → abtars SSEEvent stream.
 *
 * - text_delta  → chunk (folded into the answer)
 * - thinking_delta → thinking (streamed to the user, NOT folded into the answer)
 * - toolcall_end → one complete tool_call_delta (id+name+args); providers that
 *   only emit deltas are flushed at done as a fallback.
 * - done → done (usage + cacheRead/cacheWrite)
 * - error → throws an Error whose message carries "API error <status>", mapped
 *   via pi's classifier so L2 buckets it correctly.
 */
export async function* translatePiAiEvents(
  events: AsyncIterable<PiAssistantMessageEvent>,
  isRetryable: (m: PiAssistantMessage) => boolean = () => true,
): AsyncGenerator<SSEEvent> {
  // contentIndex → accumulated delta-only tool call (fallback when no toolcall_end)
  const partialArgs = new Map<number, { id?: string; name?: string; args: string }>();

  for await (const ev of events) {
    switch (ev.type) {
      case "text_delta":
        yield { type: "chunk", content: ev.delta };
        break;
      case "thinking_delta":
        yield { type: "thinking", content: ev.delta };
        break;
      case "toolcall_start":
      case "toolcall_delta": {
        const e = partialArgs.get(ev.contentIndex) ?? { args: "" };
        // Sync id/name from the running partial — some providers populate them
        // mid-stream and never emit toolcall_end.
        const blk = ev.partial.content[ev.contentIndex];
        if (blk && blk.type === "toolCall") { e.id = blk.id; e.name = blk.name; }
        if (ev.type === "toolcall_delta") e.args += ev.delta;
        partialArgs.set(ev.contentIndex, e);
        break;
      }
      case "toolcall_end":
        partialArgs.delete(ev.contentIndex);
        yield { type: "tool_call_delta", index: ev.contentIndex, id: ev.toolCall.id, name: ev.toolCall.name, arguments: JSON.stringify(ev.toolCall.arguments) };
        break;
      case "done": {
        // Flush any tool calls that arrived only as deltas (no toolcall_end) first,
        // so 'done' stays the terminal event.
        for (const [idx, e] of partialArgs) {
          if (e.name) yield { type: "tool_call_delta", index: idx, id: e.id, name: e.name, arguments: e.args };
        }
        const u = ev.message.usage;
        // #1311/R1: pi's usage.input EXCLUDES cache (totalTokens = input+output+cacheRead+cacheWrite).
        // prompt_tokens must be total input-side (incl cache): it matches L0 (OpenAI's prompt_tokens
        // already includes cached) for context-% parity AND makes recordUsage→budget = totalTokens
        // (cache is additive, not a subset of input).
        yield { type: "done", usage: { prompt_tokens: u.input + u.cacheRead + u.cacheWrite, completion_tokens: u.output }, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
        return;
      }
      case "error":
        throw toL2Error(ev.error, isRetryable);
    }
  }
}

export interface PiAiErrorMapping { status: number; kind: ErrorKind; retryAfterMs?: number; text: string }

/**
 * D1/D2 — "pi classifies, abtars decides." Map a pi error AssistantMessage +
 * pi's retryable verdict to abtars {status, retryAfter, kind}. The status is
 * chosen so abtars's classifyError(status) reproduces the intended kind, and
 * the detail text is preserved so parseRetryAfter/parseUsageLimitCooldown can
 * extract cooldowns from the formatted provider message.
 */
export function mapPiAiError(message: PiAssistantMessage, isRetryable: boolean): PiAiErrorMapping {
  const detail = message.errorMessage ?? "pi-ai stream error";
  const statusMatch = /\b(\d{3})\b/.exec(detail);
  const parsedStatus = statusMatch ? parseInt(statusMatch[1] as string, 10) : 0;
  const retryAfterMs = parseRetryAfter(detail) ?? parseUsageLimitCooldown(detail);

  let status: number;
  let kind: ErrorKind;
  if (isRetryable) {
    // Transient (overloaded / 503 / stream-ended / http2) → retry-friendly bucket.
    kind = "transient";
    status = parsedStatus || 500;
  } else if (/\b(quota|credit|usage[ _-]?limit|insufficient|balance|payment|plan[ _-]?limit|GoUsageLimit)\b/i.test(detail)) {
    // Usage/credit exhaustion → rotate to another model.
    kind = "rate_limit";
    status = parsedStatus || 429;
  } else if (/\b(unauth|forbidden|api[ _-]?key|invalid.{0,8}key|permission)\b/i.test(detail) || parsedStatus === 401 || parsedStatus === 403) {
    kind = "auth";
    status = parsedStatus || 401;
  } else {
    // Non-retryable, not clearly auth → rotate away (rate_limit) as the safe default.
    kind = "rate_limit";
    status = parsedStatus || 429;
  }

  return { status, kind, retryAfterMs, text: `API error ${status}: ${detail}` };
}

function toL2Error(message: PiAssistantMessage, isRetryable: (m: PiAssistantMessage) => boolean): Error {
  const mapping = mapPiAiError(message, isRetryable(message));
  const err = new Error(mapping.text);
  (err as Error & { piKind?: ErrorKind; piRetryAfterMs?: number }).piKind = mapping.kind;
  (err as Error & { piKind?: ErrorKind; piRetryAfterMs?: number }).piRetryAfterMs = mapping.retryAfterMs;
  return err;
}

// ─── orchestration ──────────────────────────────────────────────────────────

/** Injectable dependencies (tests pass fakes; production omits → lazyRequire). */
export interface PiAiStreamDeps {
  loadPi?: () => Promise<PiAiModule>;
  /** Load the api module streams for a given pi Api. */
  loadApi?: (api: PiApi) => Promise<PiProviderStreams>;
}

async function defaultLoadApi(api: PiApi): Promise<PiProviderStreams> {
  const mod = await lazyRequire<Record<string, unknown>>(`@earendil-works/pi-ai/api/${api}`, "pi-ai provider engine");
  return { stream: mod.stream as PiProviderStreams["stream"], streamSimple: mod.streamSimple as PiProviderStreams["streamSimple"] };
}

async function defaultLoadPi(): Promise<PiAiModule> {
  const pi = await lazyRequire<Record<string, unknown>>("@earendil-works/pi-ai", "pi-ai provider engine");
  return { createProvider: pi.createProvider as PiAiModule["createProvider"], isRetryableAssistantError: pi.isRetryableAssistantError as PiAiModule["isRetryableAssistantError"] };
}

/**
 * Execute one streamed completion through pi-ai for the given candidate, yielding
 * abtars SSEEvents. Load failure → throws PiAiUnavailableError (gate → L0).
 * Request failure → throws Error("API error <status>: …") (gate → L2 rotation).
 */
export async function* streamPiAiCompletion(
  candidate: PiAiCandidate,
  conv: PiAiConversation,
  signal: AbortSignal,
  deps: PiAiStreamDeps = {},
): AsyncGenerator<SSEEvent> {
  const api = pickPiApi(candidate.apiFormat);
  const providerId = deriveProviderId(candidate.endpoint);

  let pi: PiAiModule;
  let apiMod: PiProviderStreams;
  try {
    pi = await (deps.loadPi ?? defaultLoadPi)();
    apiMod = deps.loadApi ? await deps.loadApi(api) : await defaultLoadApi(api);
  } catch (err) {
    throw new PiAiUnavailableError(
      `pi-ai (${api}) could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const hasImage = conversationHasImage(conv.messages);
  const model = buildPiModel(candidate, api, hasImage, providerId);
  const context = buildPiContext(conv);
  const { level: reasoningLevel } = resolveReasoning(candidate);

  // Build a Provider FROM the candidate (single Model + api-key auth + this api's
  // streams). This is the Phase 1 boundary: pi's catalog is never consulted.
  const provider = pi.createProvider({
    id: providerId,
    name: providerId,
    baseUrl: candidate.endpoint,
    auth: {
      apiKey: {
        name: `${providerId} API key`,
        resolve: async () => candidate.apiKey
          ? { auth: { apiKey: candidate.apiKey }, source: "abtars candidate" }
          : undefined,
      },
    },
    models: [model],
    api: { stream: apiMod.stream, streamSimple: apiMod.streamSimple },
  });

  const options: Record<string, unknown> = {
    apiKey: candidate.apiKey,
    signal,
    maxTokens: candidate.maxOutput,
    maxRetries: 0, // D1 — abtars L2 owns the retry budget
    cacheRetention: "short",
  };
  if (candidate.sessionId) options.sessionId = candidate.sessionId;
  if (reasoningLevel) options.reasoning = reasoningLevel;

  const eventStream = provider.streamSimple(model, context, options);
  yield* translatePiAiEvents(eventStream, pi.isRetryableAssistantError.bind(pi));
}
