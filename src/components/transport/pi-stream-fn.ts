import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { logDebug } from "../logger.js";
import type { FallbackPolicy } from "./fallback-policy.js";
import type { ModelCandidate } from "./model-candidates.js";
import { candidateKey } from "./model-candidates.js";
import type { ExecutionTelemetryScope, ProviderCallTerminal } from "../execution-telemetry.js";
import type { StreamFn } from "./pi-core-types.js";
import { buildPiModel, pickPiApi, createPiAiAssistantStream } from "./pi-ai-adapter.js";
import { randomUUID } from "node:crypto";

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
  executionId: string;
  telemetry?: ExecutionTelemetryScope;
  createPiAiAttempt?: ProviderAttemptFactory;
  onCandidateCommitted?: (candidate: ModelCandidate) => void;
  providerRequestIdFactory?: () => string;
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

function isIdempotencyConflict(err: unknown): boolean {
  const msg = typeof err === "string" ? err
    : err instanceof Error ? err.message
    : typeof err === "object" && err !== null && "errorMessage" in err
      ? (err as { errorMessage: string }).errorMessage ?? ""
      : "";
  return msg.toLowerCase().includes("idempotency_conflict");
}

function isOpenAiCompatible(api: Api): boolean {
  return api === "openai-completions" || api === "openai-responses";
}

function buildAttemptOptions(fnOptions: SimpleStreamOptions, providerRequestId: string): SimpleStreamOptions {
  return {
    ...fnOptions,
    headers: {
      ...fnOptions.headers,
      "x-client-request-id": providerRequestId,
    },
  };
}

async function defaultCreatePiAiAttempt(
  candidate: ModelCandidate,
  model: Model<Api>,
  context: Context,
  _options: SimpleStreamOptions,
  signal: AbortSignal,
): Promise<AssistantMessageEventStream> {
  const piCandidate: import("./pi-ai-adapter.js").PiAiCandidate = {
    model: candidate.model,
    endpoint: candidate.endpoint,
    apiKey: candidate.apiKey,
    apiFormat: candidate.apiFormat,
    thinking: candidate.thinking,
    maxOutput: model.maxTokens,
    contextWindow: model.contextWindow,
  };
  const source = await createPiAiAssistantStream(piCandidate, model, context, _options, signal);
  let terminal: AssistantMessage | undefined;
  let resolveResult: ((message: AssistantMessage) => void) | undefined;
  const resultPromise = new Promise<AssistantMessage>((resolve) => { resolveResult = resolve; });
  async function* iterator(): AsyncGenerator<AssistantMessageEvent> {
    try {
      for await (const event of source) {
        yield event;
        if (isTerminal(event)) terminal = terminalResult(event) ?? terminal;
        if (event.type === "done") { resolveResult?.(event.message); terminal = event.message; }
        if (event.type === "error") { resolveResult?.(event.error); terminal = event.error; }
      }
    } finally {
      if (!terminal) terminal = assistantMessage(model, [], "error", "Stream ended without terminal event");
      resolveResult?.(terminal);
    }
  }
  return {
    [Symbol.asyncIterator]: () => iterator(),
    result: () => resultPromise,
  } as unknown as AssistantMessageEventStream;
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
      for (const candidate of options.policy.candidates) {
        const selected = options.policy.selectModel();
        if (!selected || selected !== candidate) continue;
        if (signal.aborted) {
          yield terminalError(model, "aborted", "Execution cancelled");
          return;
        }

        const attemptFactory = options.createPiAiAttempt ?? defaultCreatePiAiAttempt;
        const hasImage = context.messages.some((message) =>
          Array.isArray(message.content)
            && message.content.some((part) => part.type === "image"),
        );
        const piModel = buildPiModel({ ...candidate, maxOutput: model.maxTokens }, pickPiApi(candidate.apiFormat), hasImage, candidate.provider);

        let attemptCommitted = false;
        let retried = false;

        while (true) {
          const providerRequestId = (options.providerRequestIdFactory ?? randomUUID)();
          const attemptOptions = isOpenAiCompatible(piModel.api)
            ? buildAttemptOptions(fnOptions, providerRequestId)
            : fnOptions;

          logDebug(TAG, `provider attempt execution=${options.executionId} request=${providerRequestId} candidate=${candidateKey(candidate.model, candidate.endpoint)}`);

          const handle = options.telemetry?.beginProviderCall({
            provider: candidate.provider,
            model: candidate.model,
            candidate: candidateKey(candidate.model, candidate.endpoint),
            startedAt: Date.now(),
          });

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

          let shouldRetry = false;
          try {
            const inner = await attemptFactory(candidate, piModel, context, attemptOptions, signal);
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
                if (failed && !retried && isIdempotencyConflict(result?.errorMessage ?? "")) {
                  endTelemetry(handle, { result: "failure", endedAt: Date.now() });
                  telemetryEnded = true;
                  retried = true;
                  shouldRetry = true;
                  break;
                }
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
            if (shouldRetry) continue;
            if (attemptCommitted) {
              finishAttempt(signal.aborted ? "aborted" : "failure", terminal);
              yield terminalError(model, signal.aborted ? "aborted" : "error", "Provider stream ended without a terminal event");
              return;
            }
            if (!telemetryEnded) {
              finishAttempt("failure", terminal);
              break;
            }
          } catch (err) {
            if (!retried && isIdempotencyConflict(err)) {
              endTelemetry(handle, { result: "failure", endedAt: Date.now() });
              telemetryEnded = true;
              retried = true;
              continue;
            }
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
            break;
          }
          break;
        }
      }

      yield terminalError(model, signal.aborted ? "aborted" : "error", signal.aborted ? "Execution cancelled" : "All model candidates failed");
    };
    return wrapEventStream(outer(), () => assistantMessage(model, [], signal.aborted ? "aborted" : "error", signal.aborted ? "Execution cancelled" : "All model candidates failed"));
  };
}
