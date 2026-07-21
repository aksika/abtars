import { logWarn, logDebug } from "../logger.js";
import type { FallbackPolicy } from "./fallback-policy.js";
import type { ModelCandidate, CandidateSpec } from "./model-candidates.js";
import { candidateKey } from "./model-candidates.js";
import type { ExecutionTelemetryScope, ProviderCallTerminal } from "../execution-telemetry.js";
import type {
  StreamFn, AssistantMessageEventStream, SimpleStreamOptions,
  Usage, AgentMessage, AssistantMessage,
} from "./pi-core-types.js";
import type { PiAiCandidate, PiAiConversation } from "./pi-ai-adapter.js";
import { streamPiAiCompletion, buildPiModel, pickPiApi, buildPiContext } from "./pi-ai-adapter.js";
import type { SSEEvent } from "./sse-parser.js";
import type { ChatMessage } from "./conversation-session.js";
import type { ApiFormat } from "./pi-ai-adapter.js";

const TAG = "pi-stream-fn";

export type ProviderAttemptFactory = (
  candidate: CandidateSpec,
  model: unknown,
  context: unknown,
  options: SimpleStreamOptions,
  signal: AbortSignal,
) => Promise<AssistantMessageEventStream>;

export interface AbtarsPiStreamFnOptions {
  policy: FallbackPolicy;
  emergencyCandidate?: ModelCandidate;
  telemetry?: ExecutionTelemetryScope;
  createPiAiAttempt?: ProviderAttemptFactory;
  createL0Attempt?: ProviderAttemptFactory;
  onCandidateCommitted?: (candidate: CandidateSpec) => void;
}

interface PiStreamState {
  signal: AbortSignal;
  committedCandidate: CandidateSpec | null;
  committed: boolean;
}

function deriveProviderIdFromEndpoint(endpoint: string): string {
  try {
    const host = new URL(endpoint).hostname;
    const id = host.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return id || "abtars-direct";
  } catch {
    return "abtars-direct";
  }
}

function buildPiModelFromCandidate(candidate: ModelCandidate, overrides?: Partial<PiAiCandidate>): unknown {
  const ext = candidate as unknown as Record<string, unknown>;
  const apiFormat = ext.apiFormat as ApiFormat | undefined
    ?? (candidate.endpoint.includes("anthropic") ? "anthropic" as const : undefined);
  const api = pickPiApi(apiFormat);
  const providerId = deriveProviderIdFromEndpoint(candidate.endpoint);
  const piCandidate: PiAiCandidate = {
    model: candidate.model,
    endpoint: candidate.endpoint,
    apiKey: candidate.apiKey,
    apiFormat,
    maxOutput: ext.maxOutput as number ?? 4096,
    contextWindow: candidate.maxContext,
    thinking: ext.thinking as PiAiCandidate["thinking"] ?? overrides?.thinking,
    reasoningEffort: ext.reasoningEffort as PiAiCandidate["reasoningEffort"] ?? overrides?.reasoningEffort,
    sessionId: ext.sessionId as string | undefined ?? overrides?.sessionId,
  };
  const hasImage = ext.hasImage as boolean ?? false;
  return buildPiModel(piCandidate, api, hasImage, providerId);
}

function buildContextFromMessages(
  systemPrompt: string,
  messages: AgentMessage[],
): unknown {
  const conv: PiAiConversation = {
    messages: messages.map((m) => ({
      role: m.role === "abtars_instruction" ? "user" : m.role,
      content: m.content,
    } as ChatMessage)),
    tools: [],
  };
  const api = "openai-completions" as const;
  const providerId = "abtars";
  const ctx = buildPiContext(conv, api, providerId);
  ctx.systemPrompt = systemPrompt || ctx.systemPrompt;
  return ctx;
}

async function defaultCreatePiAiAttempt(
  candidate: CandidateSpec,
  _model: unknown,
  context: unknown,
  options: SimpleStreamOptions,
  signal: AbortSignal,
): Promise<AssistantMessageEventStream> {
  const ctx = context as { messages?: Array<Record<string, unknown>> } | null;
  const apiFormat: ApiFormat | undefined =
    candidate.endpoint.includes("anthropic") ? "anthropic" : undefined;
  const piCandidate: PiAiCandidate = {
    model: candidate.model,
    endpoint: candidate.endpoint,
    apiFormat,
    maxOutput: (options as Record<string, unknown>).maxTokens as number ?? 4096,
    contextWindow: candidate.maxContext,
  };
  const conv: PiAiConversation = {
    messages: (ctx?.messages ?? []).map((m) => ({
      role: (m?.role as string) ?? "user",
      content: typeof m?.content === "string" ? m.content : "",
    } as ChatMessage)),
    tools: [],
  };

  const sseStream = streamPiAiCompletion(piCandidate, conv, signal);

  return translateSseToPiAssistantStream(sseStream);
}

async function* translateSseToPiAssistantStream(
  sseStream: AsyncGenerator<SSEEvent>,
): AssistantMessageEventStream {
  let textAccumulator = "";
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  let usage: Usage | undefined;

  for await (const ev of sseStream) {
    switch (ev.type) {
      case "chunk":
        textAccumulator += ev.content;
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta: ev.content,
          role: "assistant",
          content: ev.content,
        } as AssistantMessage & { type: string };
        break;
      case "thinking":
        yield {
          type: "thinking_delta",
          contentIndex: 0,
          delta: ev.content,
          role: "assistant",
          content: ev.content,
        } as AssistantMessage & { type: string };
        break;
      case "tool_call_delta": {
        const index = toolCalls.length;
        const id = ev.id ?? "";
        const name = ev.name ?? "";
        const args = parseArgsObject(ev.arguments ?? "{}");
        toolCalls.push({ id, name, arguments: args });
        yield {
          type: "toolcall_start",
          contentIndex: index,
          toolCall: { id, name, arguments: args },
          role: "assistant",
          content: "",
        } as AssistantMessage & { type: string };
        yield {
          type: "toolcall_end",
          contentIndex: index,
          toolCall: { id, name, arguments: args },
          role: "assistant",
          content: "",
        } as AssistantMessage & { type: string };
        break;
      }
      case "done":
        usage = {
          input: (ev as Record<string, unknown>).usage
            ? ((ev as Record<string, unknown>).usage as Record<string, unknown>).prompt_tokens as number ?? 0
            : 0,
          output: (ev as Record<string, unknown>).usage
            ? ((ev as Record<string, unknown>).usage as Record<string, unknown>).completion_tokens as number ?? 0
            : 0,
          cacheRead: ev.cacheRead,
          cacheWrite: ev.cacheWrite,
        };
        break;
    }
  }

  yield {
    type: "message_end",
    message: {
      role: "assistant",
      content: textAccumulator,
      stopReason: toolCalls.length > 0 ? "toolUse" as const : "stop" as const,
      usage: usage ?? { input: 0, output: 0 },
    },
    role: "assistant",
    content: textAccumulator,
  } as AssistantMessage & { type: string };
}

function parseArgsObject(argsStr: string): Record<string, unknown> {
  try { return JSON.parse(argsStr) as Record<string, unknown>; } catch { return {}; }
}

const ZERO_USAGE: Usage = { input: 0, output: 0 };

function createErrorStream(errorMessage: string, stopReason: "error" | "aborted"): AssistantMessageEventStream {
  const msgRecord: Record<string, unknown> = {
    role: "assistant" as const,
    content: `[${stopReason === "aborted" ? "Cancelled" : "Error"}]: ${errorMessage}`,
    stopReason,
    usage: ZERO_USAGE,
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "message_end",
        message: msgRecord,
        role: "assistant",
        content: msgRecord.content,
      } as AssistantMessage & { type: string };
    },
  };
}

function classifyError(msg: string): { kind: "auth" | "rate_limit" | "context_exceeded" | "transient" } {
  if (msg.includes("401") || msg.includes("403") || msg.includes("auth") || msg.includes("unauth") || msg.includes("unauthorized")) {
    return { kind: "auth" };
  }
  if (msg.includes("429") || msg.includes("quota") || msg.includes("rate_limit") || msg.includes("credit") || msg.includes("rate limit")) {
    return { kind: "rate_limit" };
  }
  if (msg.includes("context_length") || msg.includes("context_length_exceeded") || msg.includes("maximum context") || msg.includes("context length")) {
    return { kind: "context_exceeded" };
  }
  return { kind: "transient" };
}

export function createPiStreamFn(
  options: AbtarsPiStreamFnOptions,
): StreamFn {
  const streamFn: StreamFn = (
    _model: unknown,
    context: unknown,
    fnOptions: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const signal: AbortSignal = (fnOptions as Record<string, unknown>).signal as AbortSignal ?? new AbortController().signal;
    const state: PiStreamState = {
      signal,
      committedCandidate: null,
      committed: false,
    };

    const ctx = context as { systemPrompt?: string; messages?: AgentMessage[] } | null;
    const systemPrompt = ctx?.systemPrompt ?? "";
    const messages: AgentMessage[] = ctx?.messages ?? [];

    const run = async function* () {
      let attemptIndex = 0;

      while (true) {
        if (state.signal.aborted) {
          yield* createErrorStream("Execution cancelled", "aborted");
          return;
        }

        const candidate = options.policy.selectModel();
        if (!candidate) {
          const emergency = options.emergencyCandidate;
          if (emergency && attemptIndex === 0) {
            logWarn(TAG, "All regular candidates exhausted — trying emergency L0");
            if (options.policy.excludedKeys.size > 0) {
              options.policy.excludedKeys.clear();
            }
            const emergencyAttempt = emergency;
            options.policy.lastDecision = { chosen: emergencyAttempt, skipped: [] };

            const telemetryHandle = options.telemetry
              ? options.telemetry.beginProviderCall({
                  provider: emergencyAttempt.provider,
                  model: emergencyAttempt.model,
                  candidate: candidateKey(emergencyAttempt.model, emergencyAttempt.endpoint),
                  fallbackFrom: attemptIndex > 0 ? options.policy.lastDecision?.chosen?.model : undefined,
                  startedAt: Date.now(),
                })
              : undefined;

            try {
              const attemptFn = options.createL0Attempt ?? defaultCreatePiAiAttempt;
              const piModel = buildPiModelFromCandidate(emergencyAttempt);
              const piContext = buildContextFromMessages(systemPrompt, messages);
              const stream = await attemptFn(emergencyAttempt, piModel, piContext, fnOptions, signal);

              let committed = false;
              for await (const ev of stream) {
                if (!committed && isSemanticEvent(ev)) {
                  committed = true;
                  state.committedCandidate = emergencyAttempt;
                  state.committed = true;
                  options.onCandidateCommitted?.(emergencyAttempt);
                  logDebug(TAG, `Emergency candidate committed: ${emergencyAttempt.model}`);
                }
                yield ev;
                if (ev.type === "message_end" || ev.type === "agent_end") {
                  if (telemetryHandle) {
                    const evMsg = ev as unknown as Record<string, unknown>;
                    const usage = (evMsg.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
                    if (usage) {
                      telemetryHandle.end({
                        result: "success",
                        endedAt: Date.now(),
                        input: usage.input as number ?? 0,
                        output: usage.output as number ?? 0,
                        cacheRead: usage.cacheRead as number | undefined,
                        cacheWrite: usage.cacheWrite as number | undefined,
                      } as ProviderCallTerminal);
                    } else {
                      telemetryHandle.end({ result: "success", endedAt: Date.now() });
                    }
                  }
                  return;
                }
              }

              if (telemetryHandle) telemetryHandle.end({ result: "success", endedAt: Date.now() });
              return;
            } catch (err) {
              if (telemetryHandle) telemetryHandle.end({ result: "failure", endedAt: Date.now() });
              const msg = err instanceof Error ? err.message : String(err);
              yield* createErrorStream(msg, "error");
              return;
            }
          }

          logWarn(TAG, "All candidates exhausted — returning error stream");
          yield* createErrorStream("All model candidates failed", "error");
          return;
        }

        attemptIndex++;

        logDebug(TAG, `Attempt ${attemptIndex}: ${candidate.model} via ${candidate.provider} (source: ${candidate.source})`);

        const telemetryHandle = options.telemetry
          ? options.telemetry.beginProviderCall({
              provider: candidate.provider,
              model: candidate.model,
              candidate: candidateKey(candidate.model, candidate.endpoint),
              fallbackFrom: attemptIndex > 1 ? options.policy.lastDecision?.chosen?.model : undefined,
              startedAt: Date.now(),
            })
          : undefined;

        let committed = false;
        const buffer: Array<AssistantMessage & { type: string }> = [];
        try {
          const attemptFn = options.createPiAiAttempt ?? defaultCreatePiAiAttempt;
          const piModel = buildPiModelFromCandidate(candidate);
          const piContext = buildContextFromMessages(systemPrompt, messages);
          const stream = await attemptFn(candidate, piModel, piContext, fnOptions, signal);

          for await (const ev of stream) {
            if (state.signal.aborted && !committed) {
              if (telemetryHandle) telemetryHandle.end({ result: "aborted", endedAt: Date.now() });
              options.policy.recordError(candidate, "transient");
              yield* createErrorStream("Execution cancelled", "aborted");
              return;
            }

            if (!committed) {
              if (isSemanticEvent(ev)) {
                committed = true;
                state.committedCandidate = candidate;
                state.committed = true;
                options.policy.recordSuccess(candidate);
                options.onCandidateCommitted?.(candidate);
                logDebug(TAG, `Candidate committed: ${candidate.model}`);

                for (const buffered of buffer) {
                  yield buffered;
                }
                buffer.length = 0;
              } else {
                buffer.push(ev);
                continue;
              }
            }

            yield ev;
          }

          if (!committed) {
            if (telemetryHandle) telemetryHandle.end({ result: "failure", endedAt: Date.now() });
            options.policy.recordError(candidate, "transient");
            continue;
          }

          if (telemetryHandle) telemetryHandle.end({ result: "success", endedAt: Date.now() });
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logDebug(TAG, `Attempt ${attemptIndex} failed: ${msg}`);

          if (telemetryHandle) telemetryHandle.end({ result: "failure", endedAt: Date.now() });

          const { kind } = classifyError(msg);
          options.policy.recordError(candidate, kind);

          if (committed) {
            logWarn(TAG, `Post-commit failure for ${candidate.model} — no fallback allowed`);
            yield* createErrorStream(msg, "error");
            return;
          }
        }
      }
    };

    return {
      [Symbol.asyncIterator]() {
        return run()[Symbol.asyncIterator]();
      },
    };
  };

  return streamFn;
}

function isSemanticEvent(ev: unknown): boolean {
  const event = ev as Record<string, unknown> | null;
  if (!event || typeof event !== "object") return false;
  if (event.type === "text_delta" && typeof event.delta === "string" && event.delta.trim().length > 0) return true;
  if (event.type === "thinking_delta") return true;
  if (event.type === "toolcall_start" || event.type === "toolcall_end") return true;
  if (event.type === "message_end") return true;
  return false;
}
