/**
 * openai-compat-routes — /v1/* handler logic (#373).
 *
 * Delegates translation to openai-compat-translate.ts and SSE formatting to
 * openai-compat-sse.ts. This module connects the pure pieces to the live
 * server-side resources (agent session, memory, injection scanner).
 *
 * Handlers are bound methods on AgentApiServer — this file exports the
 * implementation logic separated for readability. Server calls into these
 * with `this` rebound.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import type { IMemorySystem } from "abmind";
import { abmind } from "../utils/abmind-lazy.js";
import type { AgentSession } from "./subagent-runtime.js";
import {
  flattenMessages,
  composePrompt,
  buildChatResponse,
  buildModelsList,
  extractSessionKey,
  openaiError,
  validateChatRequest,
} from "./openai-compat-translate.js";
import { bufferedStreamBody } from "./openai-compat-sse.js";
import { logInfo, logWarn, logDebug } from "./logger.js";

const TAG = "openai-compat";

export interface ModelsResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** GET /v1/models — static list. */
export function handleModels(): ModelsResult {
  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildModelsList()),
  };
}

/** GET /v1/models/{id} — individual model details. */
export function handleModel(id: string): ModelsResult {
  const list = buildModelsList();
  const match = list.data.find(m => m.id === id);
  if (!match) {
    return {
      status: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(openaiError(`Model '${id}' not found`, "invalid_request_error", "model_not_found")),
    };
  }
  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(match),
  };
}

export interface EmbeddingsRequestBody {
  model?: string;
  input: string | string[];
  user?: string;
}

/** POST /v1/embeddings — delegates to memory.getEmbeddingProvider(). */
export async function handleEmbeddings(
  body: unknown,
  memory: IMemorySystem | null,
): Promise<ModelsResult> {
  const req = body as Partial<EmbeddingsRequestBody>;
  if (!req || (typeof req.input !== "string" && !Array.isArray(req.input))) {
    return {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(openaiError("Missing or invalid 'input' field", "invalid_request_error", "invalid_input")),
    };
  }

  if (!memory) {
    return {
      status: 503,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(openaiError("Memory not initialized on this host", "server_error", "memory_unavailable")),
    };
  }

  const provider = memory.getEmbeddingProvider();
  if (!provider) {
    return {
      status: 503,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(openaiError("Embeddings not configured on this host", "server_error", "embeddings_disabled")),
    };
  }

  const inputs = Array.isArray(req.input) ? req.input : [req.input];
  const vectors: Array<number[] | null> = await provider.batchEmbed(inputs);

  // Any null in vectors means the provider failed for that input — fail the whole request per OpenAI convention
  if (vectors.some(v => v === null)) {
    return {
      status: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(openaiError("Embedding provider returned no vector", "server_error", "provider_error")),
    };
  }

  const responseBody = {
    object: "list" as const,
    data: vectors.map((v, i) => ({
      object: "embedding" as const,
      embedding: Array.from(v as ArrayLike<number>),
      index: i,
    })),
    model: req.model ?? provider.name,
    usage: { prompt_tokens: 0, total_tokens: 0 }, // TODO(#373 v2): token counting
  };

  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(responseBody),
  };
}

// ── Chat completions ────────────────────────────────────────────────────────

export interface ChatCompletionsDeps {
  session: AgentSession;
  memory: IMemorySystem | null;
  agentRules: string;
  rulesAlreadyInjected: boolean;
  /** Called when rules get injected so server can flip its state flag. */
  markRulesInjected: () => void;
  /** Guest name from auth (A2A code path). */
  guestName: string;
}

export interface ChatCompletionsResult {
  status: number;
  headers: Record<string, string>;
  /** For non-streaming, a JSON string. For streaming, a raw SSE body. */
  body: string;
  /** True if response should be sent as text/event-stream (SSE). */
  streaming: boolean;
}

/** POST /v1/chat/completions — delegates to the agent via AgentSession. */
export async function handleChatCompletions(
  rawBody: unknown,
  req: IncomingMessage,
  deps: ChatCompletionsDeps,
): Promise<ChatCompletionsResult> {
  // Validate untrusted JSON — narrows unknown → OpenAIChatRequest.
  // Defensive parsing: don't trust the shape,
  // narrow field-by-field. Downstream code relies on the returned shape.
  const validation = validateChatRequest(rawBody);
  if (!validation.ok) {
    return errorResponse(400, validation.message, "invalid_request_error", validation.code);
  }
  const body = validation.value;

  const messages = body.messages;
  const stream = body.stream === true;
  const model = body.model; // already defaulted to 'kp/default' in validator

  // Log ignored OpenAI fields at DEBUG so operators know what's getting dropped
  if (body.tools || body.tool_choice) {
    logDebug(TAG, `tools[]/tool_choice present in request — ignored in v1`);
  }

  // Scan every message content for injection; any hit refuses the whole request
  const flat = flattenMessages(messages);
  for (let i = 0; i < flat.allContents.length; i++) {
    const content = flat.allContents[i]!;
    if (!content.trim()) continue;
    const scan = abmind()!.scanForInjection(content);
    if (!scan.safe) {
      const top = scan.flags[0]!;
      logWarn(TAG, `BLOCKED /v1/chat/completions — injection in messages[${i}]: ${top.category} (score=${scan.score}) from guest=${deps.guestName}`);
      const refusal = buildChatResponse({
        model,
        content: "I can't process that request — it triggered the injection guard. Please rephrase.",
      });
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(refusal),
        streaming: false,
      };
    }
  }

  if (!flat.prompt.trim()) {
    return errorResponse(400, "No non-empty user message found", "invalid_request_error", "empty_prompt");
  }

  // Compose the final prompt (system prefix if client sent one)
  let fullPrompt = composePrompt(flat);

  // Inject agent rules on first turn (preserves existing A2A behavior)
  if (deps.agentRules && !deps.rulesAlreadyInjected) {
    fullPrompt = `[AGENT RULES]\n${deps.agentRules}\n[END AGENT RULES]\n\n${fullPrompt}`;
    deps.markRulesInjected();
  }

  const sessionKey = extractSessionKey(req.headers as Record<string, string | string[] | undefined>);
  const isPeer = !!deps.guestName;
  const effectiveSessionKey = isPeer ? `${Math.floor(Date.now() / 1000)}_P_01` : sessionKey;

  // Record the NEW user turn only — skip for peer (A2A) sessions
  const now = Date.now();
  if (!isPeer) deps.memory?.recordMessage({ role: "user", content: flat.prompt, timestamp: now, userId: "master", sessionId: effectiveSessionKey });

  logInfo(TAG, `/v1/chat/completions guest=${deps.guestName} session=${effectiveSessionKey} promptLen=${flat.prompt.length} stream=${stream}`);

  // Send to the agent — this is the slow bit
  const reply = await deps.session.sendPrompt(effectiveSessionKey, fullPrompt);

  // Record the assistant turn — skip for peer (A2A) sessions
  if (!isPeer) deps.memory?.recordMessage({ role: "assistant", content: reply, timestamp: Date.now(), userId: "master", sessionId: effectiveSessionKey });

  if (stream) {
    return {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
      body: bufferedStreamBody(reply, { model }),
      streaming: true,
    };
  }

  const response = buildChatResponse({ model, content: reply });
  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
    streaming: false,
  };
}

function errorResponse(status: number, message: string, type: string, code?: string): ChatCompletionsResult {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(openaiError(message, type, code)),
    streaming: false,
  };
}

/** Helper for server to write any `ModelsResult` / `ChatCompletionsResult` uniformly. */
export function writeResult(res: ServerResponse, result: { status: number; headers: Record<string, string>; body: string }): void {
  res.writeHead(result.status, result.headers);
  res.end(result.body);
}
