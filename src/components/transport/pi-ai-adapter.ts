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

  ProviderStreams,
  SimpleStreamOptions,
  Provider,
  CreateProviderOptions,
} from "@earendil-works/pi-ai";

import { logWarn } from "../logger.js";
import { resolvePiInstallation, loadPiModule } from "../pi-installation.js";
import type { PiModuleSpecifier } from "../pi-installation.js";

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

// Legacy L0 adapter classes removed in #1447.

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

async function defaultLoadPi(): Promise<PiAiModule> {
  const result = resolvePiInstallation();
  if (result.state !== "compatible") throw new Error(`Pi not available: ${result.state}`);
  const aiSpec: PiModuleSpecifier = { package: "@earendil-works/pi-ai" };
  const piModule = await loadPiModule<Record<string, unknown>>(result.installation, aiSpec);
  return piModule as unknown as PiAiModule;
}

async function defaultLoadApi(api: Api): Promise<ProviderStreams> {
  const result = resolvePiInstallation();
  if (result.state !== "compatible") throw new Error(`Pi not available: ${result.state}`);
  const aiSpec: PiModuleSpecifier = { package: "@earendil-works/pi-ai", subpath: `api/${api}` };
  const mod = await loadPiModule<Record<string, unknown>>(result.installation, aiSpec);
  return mod as unknown as ProviderStreams;
}

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
