/**
 * pi-ai adapter — the L1 "motor prosthetic" for PiCoreTransport (#1311).
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
 * Contracts verified against @earendil-works/pi-ai@~0.80.7 via devDependency.
 */

import type {
  Api,
  ThinkingLevel,
  ModelThinkingLevel,
  Model,
  Usage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
  Tool,
  Context,
  Message,
  UserMessage,
  ToolResultMessage,
  AssistantMessage,
  AssistantMessageEvent,
  ProviderStreams,
  SimpleStreamOptions,
  Provider,
  CreateProviderOptions,
} from "@earendil-works/pi-ai";

import { logDebug, logWarn, logTrace, isLogLevel } from "../logger.js";
import { resolvePiInstallation, loadPiModule } from "../pi-installation.js";
import type { PiModuleSpecifier } from "../pi-installation.js";
import { parseRetryAfter, parseUsageLimitCooldown } from "./transport-utils.js";
import type { ErrorKind } from "./model-health-registry.js";
import type { SSEEvent } from "./sse-parser.js";

// Shared message types (moved from deleted conversation-session.ts)
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type LegacyToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: LegacyToolCall[];
  tool_call_id?: string;
  name?: string;
};

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
  /** Model's context window in tokens. #1326: propagated from DirectApiConfig
   *  so `buildPiModel` carries a real value and pi-ai's own
   *  `clampMaxTokensToContext` guard becomes functional as a second layer. */
  contextWindow?: number;
  // #1311 + #1276: thinking config — three styles.
  //   "default"  → use the model's own default reasoning level (no override, no force).
  //                pi-ai doesn't get a `reasoning` option → no `reasoning_effort` in body
  //                for openrouter/chat-completions → model uses its own default.
  //   "effort"   → force a specific effort level (pi-ai's level set, off|low|medium|high|xhigh).
  //   "extended" → Anthropic extended-budget style; `default` is the budget_tokens value.
  //                Reasoning is enabled but no level is passed to pi-ai for openrouter.
  thinking?:
    | { style: "default" }
    | { style: "effort"; default: "off" | "low" | "medium" | "high" | "xhigh" }
    | { style: "extended"; default: number };
  /** Session-level reasoning override (from /effort or /thinking command). */
  reasoningEffort?: "off" | "low" | "medium" | "high" | "xhigh" | null;
  /** Session key — used as pi's sessionId for prompt-cache affinity. */
  sessionId?: string;
}

export interface PiAiConversation {
  messages: ChatMessage[];
  tools: OpenAiToolSchema[];
}

// ─── pi-ai module wrapper (abtars-owned) ─────────────────────────────────────

/** The pi-ai root module surface this adapter uses, narrowed from the lazy require. */
export interface PiAiModule {
  createProvider(input: CreateProviderOptions): Provider;
  isRetryableAssistantError(message: AssistantMessage): boolean;
}

// ─── error tagging ──────────────────────────────────────────────────────────

/**
 * Tagged load failure. The gate catches this (by name) and falls through to L0.
 * Request errors are NOT this — they throw a plain Error with "API error <status>".
 *
 * #1318: `piFunction` is the throwing step (loadPi | loadApi) — the consumer
 * surfaces it in the WARN so debug logs identify the load step at a glance.
 */
export class PiAiUnavailableError extends Error {
  piFunction?: string;
  constructor(message: string, options?: { cause?: unknown; piFunction?: string }) {
    super(message, options);
    this.name = "PiAiUnavailableError";
    this.piFunction = options?.piFunction;
  }
}

// ─── pure translators ───────────────────────────────────────────────────────

/** Map abtars apiFormat → pi Api family. chat/undefined → openai-completions. */
export function pickPiApi(apiFormat?: ApiFormat): Api {
  if (apiFormat === "responses") return "openai-responses";
  if (apiFormat === "anthropic") return "anthropic-messages";
  return "openai-completions";
}

// #1276: align with pi-ai's effort level vocabulary. pi-ai's ThinkingLevel is
// "minimal" | "low" | "medium" | "high" | "xhigh" | "max" (ModelThinkingLevel adds
// "off"). abtars exposes a deliberate subset — the /effort + /thinking commands and
// DirectApiConfig only speak off|low|medium|high|xhigh — so the validation set
// below mirrors that abtars subset, not pi-ai's full range. (Adding "minimal"/"max"
// would be a config-surface change, out of scope for the #1425 boundary review.)
const EFFORT_LEVELS: readonly string[] = ["off", "low", "medium", "high", "xhigh"];

function mapEffortLevel(s: string | undefined): ModelThinkingLevel | undefined {
  if (!s) return undefined;
  return EFFORT_LEVELS.includes(s) ? (s as ModelThinkingLevel) : "medium";
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
 *
 * "off" levels are filtered here — pi's SimpleStreamOptions.reasoning uses
 * ThinkingLevel (which excludes "off"); to disable reasoning, omit the option.
 */
export function resolveReasoning(candidate: PiAiCandidate): { reasoning: boolean; level: ThinkingLevel | undefined } {
  if (candidate.thinking?.style === "default") return { reasoning: true, level: undefined };
  const rawLevel: ModelThinkingLevel | undefined | null = candidate.reasoningEffort
    ?? (candidate.thinking?.style === "effort" ? mapEffortLevel(candidate.thinking.default) : undefined);
  if (!rawLevel || rawLevel === "off") return { reasoning: false, level: undefined };
  return { reasoning: true, level: rawLevel };
}

/**
 * Construct a single pi Model FROM the abtars candidate (not from pi's catalog).
 * #1326: contextWindow is now sourced from `candidate.contextWindow` (the L0
 * caller has already clamped maxOutput against it) — this enables pi-ai's own
 * `clampMaxTokensToContext` client-side guard as a belt-and-suspenders second
 * layer. `?? 0` preserves the prior behavior for legacy test fixtures that
 * don't set the field (pi-ai's guard no-ops when contextWindow <= 0, matching
 * its own convention for "unknown" windows).
 */
export function buildPiModel(candidate: PiAiCandidate, api: Api, hasImage: boolean, providerId: string): Model<Api> {
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
    contextWindow: candidate.contextWindow ?? 0,
    maxTokens: candidate.maxOutput,
  };
}

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/s;

function toPiUserContent(content: string | ContentPart[] | null): string | (TextContent | ImageContent)[] {
  if (typeof content === "string" || content === null) return content ?? "";
  const parts: (TextContent | ImageContent)[] = [];
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

const ZERO_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Translate an abtars ChatMessage[] conversation → pi Context.
 * system messages collapse into systemPrompt; assistant tool_calls become pi
 * toolCall content blocks (arguments parsed to objects); tool messages become
 * pi toolResult messages.
 */
export function buildPiContext(conv: PiAiConversation, api?: Api, providerId?: string): Context {
  const systemParts: string[] = [];
  const messages: Message[] = [];
  const now = Date.now();

  for (const m of conv.messages) {
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content) systemParts.push(m.content);
      continue;
    }
    if (m.role === "user") {
      messages.push({ role: "user", content: toPiUserContent(m.content), timestamp: now } as UserMessage);
    } else if (m.role === "assistant") {
      const blocks: (TextContent | ThinkingContent | ToolCall)[] = [];
      if (typeof m.content === "string" && m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({ type: "toolCall", id: tc.id, name: tc.function.name, arguments: parseArgsObject(tc.function.arguments) });
      }
      messages.push({
        role: "assistant",
        content: blocks,
        api: api ?? "openai-completions",
        provider: providerId ?? "abtars",
        model: "",
        usage: ZERO_USAGE,
        stopReason: (m.tool_calls?.length ? "toolUse" : "stop") as AssistantMessage["stopReason"],
        timestamp: now,
      } as AssistantMessage);
    } else if (m.role === "tool") {
      const text = typeof m.content === "string" ? m.content : "";
      messages.push({
        role: "toolResult",
        toolCallId: m.tool_call_id ?? "",
        toolName: m.name ?? "",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: now,
      } as ToolResultMessage);
    }
  }

  const tools: Tool[] | undefined = conv.tools.length
    ? conv.tools.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters } as Tool))
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
  events: AsyncIterable<AssistantMessageEvent>,
  isRetryable: (m: AssistantMessage) => boolean = () => true,
): AsyncGenerator<SSEEvent> {
  // contentIndex → accumulated delta-only tool call (fallback when no toolcall_end)
  const partialArgs = new Map<number, { id?: string; name?: string; args: string }>();
  const traceRaw = isLogLevel("trace");

  for await (const ev of events) {
    if (traceRaw) {
      logTrace(TAG, `pi raw ev: ${ev.type}${"contentIndex" in ev ? ` idx=${ev.contentIndex}` : ""}${ev.type === "text_delta" || ev.type === "thinking_delta" ? ` Δ=${ev.delta.length}ch` : ""}${ev.type === "toolcall_end" ? ` tool=${ev.toolCall.name} id=${ev.toolCall.id}` : ""}${ev.type === "done" ? ` reason=${ev.reason}` : ""}${ev.type === "error" ? ` reason=${ev.reason}` : ""}`);
    }
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
        if (partialArgs.size > 0 && traceRaw) {
          logTrace(TAG, `flushing ${partialArgs.size} delta-only toolCall(s) at done`);
        }
        for (const [idx, e] of partialArgs) {
          if (e.name) yield { type: "tool_call_delta", index: idx, id: e.id, name: e.name, arguments: e.args };
        }
        const u = ev.message.usage;
        logDebug(TAG, `stream complete: input=${u.input} output=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite}`);
        yield { type: "done", usage: { prompt_tokens: u.input + u.cacheRead + u.cacheWrite, completion_tokens: u.output }, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
        return;
      }
      case "error":
        throw toL2Error(ev.error, isRetryable);
      default:
        if (traceRaw) {
          logTrace(TAG, `unhandled pi event type: ${(ev as { type: string }).type}`);
        }
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
export function mapPiAiError(message: AssistantMessage, isRetryable: boolean): PiAiErrorMapping {
  const detail = message.errorMessage ?? "pi-ai stream error";
  const statusMatch = /\b(\d{3})\b/.exec(detail);
  const parsedStatus = statusMatch ? parseInt(statusMatch[1] as string, 10) : 0;
  const retryAfterMs = parseRetryAfter(detail) ?? parseUsageLimitCooldown(detail);

  let status: number;
  let kind: ErrorKind;
  if (/maximum context length|context_length_exceeded/i.test(detail)) {
    kind = "context_exceeded";
    status = parsedStatus || 400;
  } else if (isRetryable) {
    kind = "transient";
    status = parsedStatus || 500;
  } else if (/\b(quota|credit|usage[ _-]?limit|insufficient|balance|payment|plan[ _-]?limit|GoUsageLimit)\b/i.test(detail)) {
    kind = "rate_limit";
    status = parsedStatus || 429;
  } else if (/\b(unauth|forbidden|api[ _-]?key|invalid.{0,8}key|permission)\b/i.test(detail) || parsedStatus === 401 || parsedStatus === 403) {
    kind = "auth";
    status = parsedStatus || 401;
  } else {
    kind = "rate_limit";
    status = parsedStatus || 429;
  }

  logTrace(TAG, `error map: detail="${detail.slice(0, 120)}" → status=${status} kind=${kind} retryAfterMs=${retryAfterMs ?? "none"} isRetryable=${isRetryable}`);
  return { status, kind, retryAfterMs, text: `API error ${status}: ${detail}` };
}

function toL2Error(message: AssistantMessage, isRetryable: (m: AssistantMessage) => boolean): Error {
  const mapping = mapPiAiError(message, isRetryable(message));
  const err = new Error(mapping.text);
  (err as Error & { piKind?: ErrorKind; piRetryAfterMs?: number }).piKind = mapping.kind;
  (err as Error & { piKind?: ErrorKind; piRetryAfterMs?: number }).piRetryAfterMs = mapping.retryAfterMs;
  return err;
}

// ─── orchestration ──────────────────────────────────────────────────────────

/** Injectable dependencies (tests pass fakes; production omits → ESM import). */
export interface PiAiStreamDeps {
  loadPi?: () => PiAiModule | Promise<PiAiModule>;
  /** Load the api module streams for a given pi Api. */
  loadApi?: (api: Api) => ProviderStreams | Promise<ProviderStreams>;
}

async function defaultLoadApi(api: Api): Promise<ProviderStreams> {
  const result = resolvePiInstallation();
  if (result.state !== "compatible") throw new PiAiUnavailableError(`Pi not available: ${result.state}`);
  const aiSpec: PiModuleSpecifier = { package: "@earendil-works/pi-ai", subpath: `api/${api}` };
  const mod = await loadPiModule<Record<string, unknown>>(result.installation, aiSpec);
  if (typeof mod.stream !== "function" || typeof mod.streamSimple !== "function") {
    throw new PiAiUnavailableError(`pi-ai/api/${api}: missing stream/streamSimple exports`);
  }
  return { stream: mod.stream as ProviderStreams["stream"], streamSimple: mod.streamSimple as ProviderStreams["streamSimple"] };
}

async function defaultLoadPi(): Promise<PiAiModule> {
  const result = resolvePiInstallation();
  if (result.state !== "compatible") throw new PiAiUnavailableError(`Pi not available: ${result.state}`);
  const aiSpec: PiModuleSpecifier = { package: "@earendil-works/pi-ai" };
  const piModule = await loadPiModule<Record<string, unknown>>(result.installation, aiSpec);
  if (typeof piModule.createProvider !== "function" || typeof piModule.isRetryableAssistantError !== "function") {
    throw new PiAiUnavailableError(`pi-ai: missing createProvider/isRetryableAssistantError exports`);
  }
  return {
    createProvider: piModule.createProvider as PiAiModule["createProvider"],
    isRetryableAssistantError: piModule.isRetryableAssistantError as PiAiModule["isRetryableAssistantError"],
  };
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
  let apiMod: ProviderStreams;
  try {
    pi = await (deps.loadPi ?? defaultLoadPi)();
  } catch (err) {
    if (isLogLevel("trace")) logTrace(TAG, `pi-ai load failed for api=${api} (loadPi): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    throw new PiAiUnavailableError(
      `pi-ai (${api}) could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err, piFunction: "loadPi" },
    );
  }
  try {
    apiMod = await (deps.loadApi ? deps.loadApi(api) : defaultLoadApi(api));
  } catch (err) {
    if (isLogLevel("trace")) logTrace(TAG, `pi-ai load failed for api=${api} (loadApi): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    throw new PiAiUnavailableError(
      `pi-ai (${api}) could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err, piFunction: "loadApi" },
    );
  }
  const hasImage = conversationHasImage(conv.messages);
  logTrace(TAG, `resolve: apiFormat=${candidate.apiFormat ?? "chat"} → piApi=${api} providerId=${providerId} hasImage=${hasImage}`);
  const model = buildPiModel(candidate, api, hasImage, providerId);
  const { reasoning, level: reasoningLevel } = resolveReasoning(candidate);
  logTrace(TAG, `piModel: id=${model.id} baseUrl=${model.baseUrl} reasoning=${reasoning} maxTokens=${model.maxTokens} reasoningLevel=${reasoningLevel ?? "none"}`);
  const context = buildPiContext(conv, api, providerId);
  logTrace(TAG, `piContext: systemPromptLen=${context.systemPrompt?.length ?? 0} messages=${context.messages.length} tools=${context.tools?.length ?? 0}`);

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

  const options: SimpleStreamOptions & Record<string, unknown> = {
    apiKey: candidate.apiKey,
    signal,
    maxTokens: candidate.maxOutput,
    maxRetries: 0,
    cacheRetention: "short",
  };
  if (candidate.sessionId) options.sessionId = candidate.sessionId;
  if (reasoningLevel) options.reasoning = reasoningLevel;

  logDebug(TAG, `resolved: piModelId=${model.id} endpoint=${candidate.endpoint} reasoning=${JSON.stringify(reasoning)}`);
  logTrace(TAG, `streamSimple options: maxTokens=${options.maxTokens} maxRetries=${options.maxRetries} cacheRetention=${options.cacheRetention} sessionId=${options.sessionId ?? "none"} reasoning=${options.reasoning ?? "none"} apiKey=${candidate.apiKey ? "***set***" : "none"}`);

  const eventStream = provider.streamSimple(model, context, options);
  yield* translatePiAiEvents(eventStream, pi.isRetryableAssistantError.bind(pi));
}

/**
 * Public Pi stream used by the pi-agent-core boundary. This deliberately
 * returns pi-ai's native AssistantMessageEventStream; the legacy SSE adapter
 * above remains only for the PiCoreTransport path.
 */
export async function createPiAiAssistantStream(
  candidate: PiAiCandidate,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  signal: AbortSignal,
): Promise<import("@earendil-works/pi-ai").AssistantMessageEventStream> {
  const api = pickPiApi(candidate.apiFormat);
  const pi = await (defaultLoadPi)();
  const apiMod = await defaultLoadApi(api);
  const providerId = deriveProviderId(candidate.endpoint);
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
  return provider.streamSimple(model, context, {
    ...options,
    apiKey: candidate.apiKey,
    signal,
    maxRetries: 0,
  });
}
