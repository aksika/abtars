import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import { logDebug } from "../logger.js";
import type { FallbackPolicy } from "./fallback-policy.js";
import type { ModelCandidate } from "./model-candidates.js";
import { candidateKey } from "./model-candidates.js";
import type { ExecutionTelemetryScope, ProviderCallTerminal } from "../execution-telemetry.js";
import type { StreamFn } from "./pi-core-types.js";
import { createPiAiAssistantStream, buildPiModel, pickPiApi } from "./pi-ai-adapter.js";
import type { PiAiCandidate, PiAiConversation } from "./pi-ai-adapter.js";
import { streamPiAiCompletion } from "./pi-ai-adapter.js";
import type { SSEEvent } from "./sse-parser.js";
import type { ChatMessage } from "./pi-ai-adapter.js";

const TAG = "pi-stream-fn";

export type ProviderAttemptFactory = (
  candidate: ModelCandidate,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  signal: AbortSignal,
) => Promise<AssistantMessageEventStream>;

export interface AbtarsPiStreamFnOptions {
  policy: FallbackPolicy;
  emergencyCandidate?: ModelCandidate;
  telemetry?: ExecutionTelemetryScope;
  createPiAiAttempt?: ProviderAttemptFactory;
  createL0Attempt?: ProviderAttemptFactory;
  onCandidateCommitted?: (candidate: ModelCandidate) => void;
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantMessage(
  model: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
  usage: Usage = zeroUsage(),
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function terminalError(model: Model<Api>, reason: "error" | "aborted", text: string): AssistantMessageEvent {
  return {
    type: "error",
    reason,
    error: assistantMessage(model, [], reason, text),
  };
}

function isTerminal(event: AssistantMessageEvent): boolean {
  return event.type === "done" || event.type === "error";
}

function isSemanticEvent(event: AssistantMessageEvent): boolean {
  if (event.type === "text_delta" || event.type === "thinking_delta") return event.delta.trim().length > 0;
  return event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end";
}

function terminalResult(event: AssistantMessageEvent): AssistantMessage | undefined {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return undefined;
}

function endTelemetry(handle: ReturnType<ExecutionTelemetryScope["beginProviderCall"]> | undefined, terminal: ProviderCallTerminal): void {
  handle?.end(terminal);
}

function contextToLegacyConversation(context: Context): { conversation: PiAiConversation } {
  const messages: ChatMessage[] = context.systemPrompt
    ? [{ role: "system", content: context.systemPrompt }]
    : [];
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }) });
    } else if (message.role === "assistant") {
      const text = message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("");
      const toolCalls = message.content.filter((part): part is ToolCall => part.type === "toolCall").map((part) => ({ id: part.id, type: "function" as const, function: { name: part.name, arguments: JSON.stringify(part.arguments) } }));
      messages.push({ role: "assistant", content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
    } else if (message.role === "toolResult") {
      messages.push({ role: "tool", content: message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join(""), tool_call_id: message.toolCallId, name: message.toolName });
    }
  }
  return {
    conversation: {
      messages,
      tools: (context.tools ?? []).map((tool) => ({
        type: "function" as const,
        function: { name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> },
      })),
    },
  };
}

async function defaultCreatePiAiAttempt(
  candidate: ModelCandidate,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  signal: AbortSignal,
): Promise<AssistantMessageEventStream> {
  const piCandidate: PiAiCandidate = {
    ...candidate,
    apiFormat: candidate.endpoint.includes("anthropic") ? "anthropic" : undefined,
    maxOutput: model.maxTokens,
    contextWindow: model.contextWindow,
  };
  return createPiAiAssistantStream(piCandidate, model, context, options, signal);
}

async function defaultCreateL0Attempt(
  candidate: ModelCandidate,
  model: Model<Api>,
  context: Context,
  _options: SimpleStreamOptions,
  signal: AbortSignal,
): Promise<AssistantMessageEventStream> {
  const legacy = contextToLegacyConversation(context);
  const piCandidate: PiAiCandidate = {
    model: candidate.model,
    endpoint: candidate.endpoint,
    apiKey: candidate.apiKey,
    apiFormat: candidate.endpoint.includes("anthropic") ? "anthropic" : undefined,
    maxOutput: model.maxTokens,
    contextWindow: model.contextWindow,
  };
  return createL0AssistantStream(streamPiAiCompletion(piCandidate, legacy.conversation, signal), model, signal);
}

function createL0AssistantStream(events: AsyncGenerator<SSEEvent>, model: Model<Api>, signal: AbortSignal): AssistantMessageEventStream {
  const output: AssistantMessage = assistantMessage(model, [], "stop");
  let textBlock: TextContent | undefined;
  let thinkingBlock: ThinkingContent | undefined;
  let terminal: AssistantMessage | undefined;

  async function* run(): AsyncGenerator<AssistantMessageEvent> {
    yield { type: "start", partial: output };
    try {
      for await (const event of events) {
        if (signal.aborted) {
          terminal = assistantMessage(model, output.content, "aborted", "Execution cancelled", output.usage);
          yield { type: "error", reason: "aborted", error: terminal };
          return;
        }
        if (event.type === "chunk") {
          if (!textBlock) {
            textBlock = { type: "text", text: "" };
            output.content.push(textBlock);
            yield { type: "text_start", contentIndex: output.content.length - 1, partial: output };
          }
          textBlock.text += event.content;
          yield { type: "text_delta", contentIndex: output.content.indexOf(textBlock), delta: event.content, partial: output };
        } else if (event.type === "thinking") {
          if (!thinkingBlock) {
            thinkingBlock = { type: "thinking", thinking: "" };
            output.content.push(thinkingBlock);
            yield { type: "thinking_start", contentIndex: output.content.length - 1, partial: output };
          }
          thinkingBlock.thinking += event.content;
          yield { type: "thinking_delta", contentIndex: output.content.indexOf(thinkingBlock), delta: event.content, partial: output };
        } else if (event.type === "tool_call_delta") {
          const call: ToolCall = { type: "toolCall", id: event.id ?? `tool_${Date.now()}`, name: event.name ?? "", arguments: parseJson(event.arguments ?? "{}") };
          output.content.push(call);
          const index = output.content.length - 1;
          yield { type: "toolcall_start", contentIndex: index, partial: output };
          yield { type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: output };
          yield { type: "toolcall_end", contentIndex: index, toolCall: call, partial: output };
        } else if (event.type === "done") {
          const usage = event.usage;
          if (usage) {
            output.usage = {
              ...output.usage,
              input: usage.prompt_tokens,
              output: usage.completion_tokens,
              totalTokens: usage.prompt_tokens + usage.completion_tokens,
            };
          }
          output.stopReason = output.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
          terminal = output;
          if (textBlock) yield { type: "text_end", contentIndex: output.content.indexOf(textBlock), content: textBlock.text, partial: output };
          if (thinkingBlock) yield { type: "thinking_end", contentIndex: output.content.indexOf(thinkingBlock), content: thinkingBlock.thinking, partial: output };
          yield { type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : "stop", message: output };
          return;
        }
      }
      terminal = assistantMessage(model, output.content, "stop", undefined, output.usage);
      yield { type: "done", reason: "stop", message: terminal };
    } catch (err) {
      terminal = assistantMessage(model, output.content, signal.aborted ? "aborted" : "error", "Provider stream failed", output.usage);
      yield { type: "error", reason: signal.aborted ? "aborted" : "error", error: terminal };
    }
  }

  return wrapEventStream(run(), () => terminal ?? assistantMessage(model, output.content, signal.aborted ? "aborted" : "error", "Provider stream ended without a terminal event", output.usage));
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function wrapEventStream(source: AsyncGenerator<AssistantMessageEvent>, fallback: () => AssistantMessage): AssistantMessageEventStream {
  let result: AssistantMessage | undefined;
  let resolveResult: ((message: AssistantMessage) => void) | undefined;
  const resultPromise = new Promise<AssistantMessage>((resolve) => { resolveResult = resolve; });
  async function* iterator(): AsyncGenerator<AssistantMessageEvent> {
    try {
      for await (const event of source) {
        const message = terminalResult(event);
        if (message) {
          result = message;
          resolveResult?.(message);
        }
        yield event;
      }
    } finally {
      if (!result) {
        result = fallback();
        resolveResult?.(result);
      }
    }
  }
  return {
    [Symbol.asyncIterator]: () => iterator(),
    result: async () => result ?? resultPromise,
  } as unknown as AssistantMessageEventStream;
}

export function createPiStreamFn(options: AbtarsPiStreamFnOptions): StreamFn {
  return (model: Model<Api>, context: Context, fnOptions: SimpleStreamOptions = {}): AssistantMessageEventStream => {
    const signal = fnOptions.signal ?? new AbortController().signal;
    const outer = async function* (): AsyncGenerator<AssistantMessageEvent> {
      const candidates = [...options.policy.candidates];
      if (options.emergencyCandidate) candidates.push(options.emergencyCandidate);

      for (const candidate of candidates) {
        if (!options.emergencyCandidate || candidate !== options.emergencyCandidate) {
          const selected = options.policy.selectModel();
          if (!selected || selected !== candidate) continue;
        }
        if (signal.aborted) {
          yield terminalError(model, "aborted", "Execution cancelled");
          return;
        }

        const handle = options.telemetry?.beginProviderCall({
          provider: candidate.provider,
          model: candidate.model,
          candidate: candidateKey(candidate.model, candidate.endpoint),
          startedAt: Date.now(),
        });
        const attemptFactory = candidate.source === "emergency"
          ? (options.createL0Attempt ?? defaultCreateL0Attempt)
          : (options.createPiAiAttempt ?? defaultCreatePiAiAttempt);
        const piModel = buildPiModel({ ...candidate, maxOutput: model.maxTokens }, pickPiApi(candidate.endpoint.includes("anthropic") ? "anthropic" : undefined), false, candidate.provider);
        let attemptCommitted = false;
        let telemetryEnded = false;
        const finishAttempt = (result: ProviderCallTerminal["result"], message?: AssistantMessage): void => {
          if (telemetryEnded) return;
          telemetryEnded = true;
          endTelemetry(handle, {
            result,
            endedAt: Date.now(),
            input: message?.usage.input,
            output: message?.usage.output,
            cacheRead: message?.usage.cacheRead,
            cacheWrite: message?.usage.cacheWrite,
          });
          if (result === "success") {
            options.policy.recordSuccess(candidate);
          } else {
            options.policy.recordError(candidate, "transient");
            options.policy.excludedKeys.add(candidateKey(candidate.model, candidate.endpoint));
          }
        };
        try {
          const inner = await attemptFactory(candidate, piModel, context, fnOptions, signal);
          const buffered: AssistantMessageEvent[] = [];
          let terminal: AssistantMessage | undefined;
          for await (const event of inner) {
            terminal = terminalResult(event) ?? terminal;
            if (!attemptCommitted && isSemanticEvent(event)) {
              attemptCommitted = true;
              options.onCandidateCommitted?.(candidate);
              for (const bufferedEvent of buffered) yield bufferedEvent;
              buffered.length = 0;
            }
            if (!attemptCommitted && isTerminal(event)) {
              const result = terminalResult(event);
              const failed = event.type === "error" || result?.stopReason === "error" || result?.stopReason === "aborted";
              if (failed) {
                finishAttempt(event.type === "error" && event.reason === "aborted" ? "aborted" : "failure", terminal);
                break;
              }
              finishAttempt("success", terminal);
              for (const bufferedEvent of buffered) yield bufferedEvent;
              yield event;
              return;
            }
            if (attemptCommitted) yield event;
            else buffered.push(event);
            if (attemptCommitted && isTerminal(event)) {
              const result = terminalResult(event);
              const failed = event.type === "error" || result?.stopReason === "error" || result?.stopReason === "aborted";
              finishAttempt(failed
                ? (event.type === "error" && event.reason === "aborted" ? "aborted" : "failure")
                : "success", terminal);
              return;
            }
          }
          if (attemptCommitted) {
            finishAttempt(signal.aborted ? "aborted" : "failure", terminal);
            yield terminalError(model, signal.aborted ? "aborted" : "error", "Provider stream ended without a terminal event");
            return;
          }
          if (!telemetryEnded) {
            finishAttempt("failure", terminal);
            continue;
          }
        } catch (err) {
          finishAttempt(signal.aborted ? "aborted" : "failure");
          if (attemptCommitted) {
            yield terminalError(model, signal.aborted ? "aborted" : "error", "Provider stream failed after output began");
            return;
          }
          logDebug(TAG, `Provider attempt failed before commit (${err instanceof Error ? err.name : "unknown"})`);
          if (signal.aborted) {
            yield terminalError(model, "aborted", "Execution cancelled");
            return;
          }
        }
      }

      yield terminalError(model, signal.aborted ? "aborted" : "error", signal.aborted ? "Execution cancelled" : "All model candidates failed");
    };
    return wrapEventStream(outer(), () => assistantMessage(model, [], signal.aborted ? "aborted" : "error", signal.aborted ? "Execution cancelled" : "All model candidates failed"));
  };
}
