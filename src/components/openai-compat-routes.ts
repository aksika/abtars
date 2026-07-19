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

import { ServerResponse } from "node:http";
import type { AbtarsMemoryRuntime } from "./memory-runtime.js";
import { buildModelsList, openaiError } from "./openai-compat-translate.js";

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
  memoryRuntime: Pick<AbtarsMemoryRuntime, "embed"> | null,
): Promise<ModelsResult> {
  const req = body as Partial<EmbeddingsRequestBody>;
  if (!req || (typeof req.input !== "string" && !Array.isArray(req.input))) {
    return {
      status: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(openaiError("Missing or invalid 'input' field", "invalid_request_error", "invalid_input")),
    };
  }

  if (!memoryRuntime) {
    return {
      status: 503,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(openaiError("Memory not initialized on this host", "server_error", "memory_unavailable")),
    };
  }

  const inputs = Array.isArray(req.input) ? req.input : [req.input];
  let embedded: Awaited<ReturnType<NonNullable<typeof memoryRuntime>["embed"]>>;
  try {
    embedded = await memoryRuntime.embed({ texts: inputs });
  } catch {
    return {
      status: 503,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(openaiError("Embeddings not configured on this host", "server_error", "embeddings_disabled")),
    };
  }
  const vectors = embedded.vectors;

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
    model: req.model ?? embedded.model,
    usage: { prompt_tokens: 0, total_tokens: 0 }, // TODO(#373 v2): token counting
  };

  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(responseBody),
  };
}

// ── Chat completions: removed (#1302) ───────────────────────────────────────
// The peer path routes through AgentApiAdapter → Spin (see agent-api-server.ts).
// The legacy in-session handleChatCompletions() was the only caller and is gone.

/** Helper for server to write any `ModelsResult` / `ChatCompletionsResult` uniformly. */
export function writeResult(res: ServerResponse, result: { status: number; headers: Record<string, string>; body: string }): void {
  res.writeHead(result.status, result.headers);
  res.end(result.body);
}
