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
import { classifyError, type ErrorKind } from "./model-health-registry.js";
import { parseErrorStatus, parseRetryAfter } from "./transport-utils.js";
import type { ProviderTerminalFailure } from "./provider-failure.js";
import type { ExecutionTelemetryScope, ProviderCallTerminal } from "../execution-telemetry.js";
import type { StreamFn } from "./pi-core-types.js";
import { buildPiModel, pickPiApi, createPiAiAssistantStream } from "./pi-ai-adapter.js";
import { randomUUID } from "node:crypto";
import { ProviderAttemptRunner } from "./provider-attempt-runner.js";
import type { ProviderAttemptExit, ProviderAttemptFactory } from "./provider-attempt-runner.js";

const TAG = "pi-stream-fn";

// Re-exported for callers that imported the attempt factory type from here.
export type { ProviderAttemptFactory } from "./provider-attempt-runner.js";

export interface AbtarsPiStreamFnOptions {
  policy: FallbackPolicy;
  executionId: string;
  telemetry?: ExecutionTelemetryScope;
  createPiAiAttempt?: ProviderAttemptFactory;
  onCandidateCommitted?: (candidate: ModelCandidate) => void;
  providerRequestIdFactory?: () => string;
  /** #1619: session-scoped requested reasoning effort threaded into every
   *  candidate model build so `model.reasoning` matches the requested level
   *  regardless of which candidate commits. */
  reasoningEffort?: import("./kiro-transport.js").ReasoningEffort;
  /** #1506: Max inactivity (no stream event) before candidate is aborted.
   *  Capped by remaining absolute deadline when passed via deadlineAt. */
  providerInactivityTimeoutMs?: number;
  /** #1506: Absolute deadline epoch ms — inactivity timeout is capped by remaining. */
  deadlineAt?: number;
  /** #1297: execution-local terminal-failure channel. Fired once when the
   *  fallback loop exhausts with every candidate sticky credit-failed. */
  onTerminalFailure?: (failure: ProviderTerminalFailure) => void;
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

/** #1297: classify a provider attempt failure through the existing model-health
 *  classifier. Status/message interpretation stays at the adapter boundary —
 *  downstream consumers never match provider error strings. */
function classifyAttemptError(err: unknown): { kind: ErrorKind; retryAfterMs?: number } {
  const status = parseErrorStatus(err);
  const msg = err instanceof Error ? err.message : String(err);
  return { kind: classifyError(status, msg), retryAfterMs: parseRetryAfter(err) };
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
      // Start with the policy's selected candidate, then walk the remaining
      // candidates. Rotation can select a later candidate (for example B
      // after A's successful-turn budget); keeping the selected candidate
      // first ensures a provider failure can still fall back to A in the same
      // logical turn after rotation state is cleared.
      const firstSelected = options.policy.selectModel();
      const orderedCandidates = firstSelected
        ? [firstSelected, ...options.policy.candidates.filter((candidate) => candidate !== firstSelected)]
        : [];
      let attemptedCandidateCount = 0;
      for (const candidate of orderedCandidates) {
        const selected = options.policy.selectModel();
        if (!selected || selected !== candidate) continue;
        attemptedCandidateCount++;
        if (signal.aborted) {
          yield terminalError(model, "aborted", "Execution cancelled");
          return;
        }

        const attemptFactory = options.createPiAiAttempt ?? defaultCreatePiAiAttempt;
        const hasImage = context.messages.some((message) =>
          Array.isArray(message.content)
            && message.content.some((part) => part.type === "image"),
        );
        const piModel = buildPiModel({
          ...candidate,
          reasoningEffort: options.reasoningEffort,
          maxOutput: model.maxTokens,
        }, pickPiApi(candidate.apiFormat), hasImage, candidate.provider);

        let attemptCommitted = false;
        let retried = false;

        while (true) {
          const providerRequestId = (options.providerRequestIdFactory ?? randomUUID)();
          const attemptOptions = isOpenAiCompatible(piModel.api)
            ? buildAttemptOptions(fnOptions, providerRequestId)
            : { ...fnOptions };

          logDebug(TAG, `provider attempt execution=${options.executionId} request=${providerRequestId} candidate=${candidateKey(candidate.model, candidate.endpoint)}`);

          const handle = options.telemetry?.beginProviderCall({
            provider: candidate.provider,
            model: candidate.model,
            candidate: candidateKey(candidate.model, candidate.endpoint),
            startedAt: Date.now(),
          });

          let telemetryEnded = false;
          // #1534: an aborted attempt (operator /stop, execution deadline, or
          // signal cut) is not a candidate failure. Recording a transient
          // error and excluding the candidate there would poison the health
          // registry and leave the session transport with an excluded
          // candidate, so a post-cancel continuation turn would fail with
          // "no candidates" instead of reaching the provider. Genuine
          // failures — and inactivity stalls, which the fallback chain needs
          // to skip — still poison via poisonCandidate().
          // #1297: the actual classification (credits, auth, rate_limit,
          // transient, ...) is recorded, not an unconditional transient.
          const poisonCandidate = (kind: ErrorKind = "transient", retryAfterMs?: number): void => {
            options.policy.recordError(candidate, kind, retryAfterMs);
            options.policy.excludedKeys.add(candidateKey(candidate.model, candidate.endpoint));
            // A provider failure is a fallback event, not a successful-turn
            // rotation event. Healthy candidates from the prior rotation
            // cycle must be eligible for recovery.
            options.policy.rotationExcludedKeys.clear();
          };
          const finishAttempt = (result: ProviderCallTerminal["result"], message?: AssistantMessage, kind?: ErrorKind, retryAfterMs?: number): void => {
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
            } else if (result !== "aborted") {
              poisonCandidate(kind, retryAfterMs);
            }
          };

          if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) {
            finishAttempt("aborted");
            yield terminalError(model, "aborted", "Execution deadline reached before provider attempt");
            return;
          }

          let shouldRetry = false;
          // #1506: the whole provider attempt (acquisition AND streaming) is
          // owned by one liveness runner whose inactivity/abort/deadline scope
          // is armed before the first external await. Acquisition can no longer
          // hang without an iterator for the watchdog to observe.
          const runner = new ProviderAttemptRunner({
            executionId: options.executionId,
            requestId: providerRequestId,
            candidate,
            model: piModel,
            context,
            options: attemptOptions,
            attemptFactory,
            signal,
            deadlineAt: options.deadlineAt,
            inactivityTimeoutMs: options.providerInactivityTimeoutMs ?? 180_000,
          });

          const buffered: AssistantMessageEvent[] = [];
          let terminal: AssistantMessage | undefined;
          let exit: ProviderAttemptExit | null = null;
          try {
            for await (const item of runner.run()) {
              if (item.kind !== "event") {
                exit = item;
                break;
              }
              const event = item.event;
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
                  const classified = classifyAttemptError(terminal?.errorMessage ?? "");
                  finishAttempt(event.type === "error" && event.reason === "aborted" ? "aborted" : "failure", terminal, classified.kind, classified.retryAfterMs);
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
                const classified = classifyAttemptError(terminal?.errorMessage ?? "");
                finishAttempt(failed
                  ? (event.type === "error" && event.reason === "aborted" ? "aborted" : "failure")
                  : "success", terminal, failed ? classified.kind : undefined, failed ? classified.retryAfterMs : undefined);
                return;
              }
            }
          } catch (err) {
            if (!retried && isIdempotencyConflict(err)) {
              endTelemetry(handle, { result: "failure", endedAt: Date.now() });
              telemetryEnded = true;
              retried = true;
              continue;
            }
            const classified = classifyAttemptError(err);
            finishAttempt(signal.aborted ? "aborted" : "failure", undefined, classified.kind, classified.retryAfterMs);
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

          if (exit) {
            if (exit.kind === "timeout") {
              logDebug(TAG, `provider_attempt_timeout execution=${options.executionId} request=${providerRequestId} phase=${exit.phase} elapsed_ms=${exit.elapsedMs}`);
              if (attemptCommitted) {
                // #1506: a streaming inactivity stall after semantic output
                // is a genuine candidate failure, but fallback is forbidden
                // once output was emitted. Operator/deadline cancellation has
                // signal.aborted=true and must not poison health.
                if (!signal.aborted) poisonCandidate();
                finishAttempt("aborted", terminal);
                yield terminalError(model, "aborted", `provider_stream_timeout after ${exit.elapsedMs}ms inactivity (semantic output was emitted)`);
                return;
              }
              // #1534: exclude only genuine inactivity stalls (the signal was
              // NOT aborted) so the fallback chain skips them; an
              // operator/execution abort must never poison the candidate.
              if (!signal.aborted) poisonCandidate();
              finishAttempt("aborted", terminal);
              break;
            }
            if (exit.kind === "aborted") {
              finishAttempt("aborted", terminal);
              yield terminalError(model, "aborted", "Execution cancelled");
              return;
            }
            if (exit.kind === "failed") {
              const err = exit.error;
              if (!retried && isIdempotencyConflict(err)) {
                endTelemetry(handle, { result: "failure", endedAt: Date.now() });
                telemetryEnded = true;
                retried = true;
                continue;
              }
              const classified = classifyAttemptError(err);
              finishAttempt(signal.aborted ? "aborted" : "failure", undefined, classified.kind, classified.retryAfterMs);
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
            // exit.kind === "ended": the stream completed without a terminal event.
            if (attemptCommitted) {
              finishAttempt(signal.aborted ? "aborted" : "failure", terminal);
              yield terminalError(model, signal.aborted ? "aborted" : "error", "Provider stream ended without a terminal event");
              return;
            }
            if (!telemetryEnded) {
              finishAttempt(signal.aborted ? "aborted" : "failure", terminal);
              break;
            }
          } else if (shouldRetry) {
            continue;
          } else if (attemptCommitted) {
            finishAttempt(signal.aborted ? "aborted" : "failure", terminal);
            yield terminalError(model, signal.aborted ? "aborted" : "error", "Provider stream ended without a terminal event");
            return;
          } else if (!telemetryEnded) {
            finishAttempt(signal.aborted ? "aborted" : "failure", terminal);
          }
          break;
        }
      }

      // #1297: the strict all-candidates credit predicate is evaluated only at
      // true exhaustion — never after the first credit failure and never when a
      // viable candidate remains. Candidates skipped this call because shared
      // health already marks them credit-failed are included by the predicate.
      if (!signal.aborted && options.policy.allCandidatesCreditFailed()) {
        options.onTerminalFailure?.({
          code: "credits_exhausted",
          retryable: false,
          attemptedCandidates: attemptedCandidateCount,
          message: "All model candidates are blocked by provider credit exhaustion",
        });
      }
      yield terminalError(model, signal.aborted ? "aborted" : "error", signal.aborted ? "Execution cancelled" : "All model candidates failed");
    };
    return wrapEventStream(outer(), () => assistantMessage(model, [], signal.aborted ? "aborted" : "error", signal.aborted ? "Execution cancelled" : "All model candidates failed"));
  };
}
