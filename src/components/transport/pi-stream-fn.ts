import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  CacheRetention,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { logDebug, redactSecrets } from "../logger.js";
import type { ModelCandidate } from "./model-candidates.js";
import { candidateKey } from "./model-candidates.js";
import { parseErrorStatus, parseRetryAfter } from "./transport-utils.js";
import type { ProviderTerminalFailure, ErrorKind } from "./provider-failure.js";
import { classifyError } from "./provider-failure.js";
import type { ExecutionTelemetryScope, ProviderCallTerminal } from "../execution-telemetry.js";
import type { StreamFn } from "./pi-core-types.js";
import { buildPiModel, pickPiApi, createPiAiAssistantStream } from "./pi-ai-adapter.js";
import type { PiAiModule } from "./pi-ai-adapter.js";
import { randomUUID } from "node:crypto";
import { ProviderAttemptRunner } from "./provider-attempt-runner.js";
import type { ProviderAttemptBundle, ProviderAttemptExit, ProviderAttemptFactory } from "./provider-attempt-runner.js";
import { recordPiMemoObservation } from "../pi-session/pi-memo-observer.js";
import {
  applyMemoSuccess,
  loadAvailabilityMemo,
  saveAvailabilityMemo,
} from "../pi-session/provider-availability-memo.js";

const TAG = "pi-stream-fn";

// Re-exported for callers that imported the attempt factory type from here.
export type { ProviderAttemptFactory } from "./provider-attempt-runner.js";

export interface AbtarsPiStreamFnOptions {
  /** #1932: the single configured candidate for this execution. No fallback
   *  chain, no rotation, no health-gated selection — the transport admits
   *  exactly one candidate per role and the memo suppresses known-dead
   *  selections before this boundary. */
  candidate: ModelCandidate;
  executionId: string;
  telemetry?: ExecutionTelemetryScope;
  createPiAiAttempt?: ProviderAttemptFactory;
  onCandidateCommitted?: (candidate: ModelCandidate) => void;
  providerRequestIdFactory?: () => string;
  /** #1619: session-scoped requested reasoning effort threaded into the
   *  candidate model build so `model.reasoning` matches the requested level. */
  reasoningEffort?: import("./kiro-transport.js").ReasoningEffort;
  /** #1506: Max inactivity (no stream event) before the attempt is aborted.
   *  Capped by remaining absolute deadline when passed via deadlineAt. */
  providerInactivityTimeoutMs?: number;
  /** #1506: Absolute deadline epoch ms — inactivity timeout is capped by remaining. */
  deadlineAt?: number;
  /** #1297: execution-local terminal-failure channel. Fired once when the
   *  single attempt fails: memoizable account-limit exhaustion
   *  (`credits_exhausted`), over-context (`context_overflow`), or any other
   *  genuine failure (`all_candidates_failed`, #1905). */
  onTerminalFailure?: (failure: ProviderTerminalFailure) => void;
  /** #1748: opaque per-session cache identity forwarded as pi's
   *  `options.sessionId`. Stable across turns; derived once per transport,
   *  never per execution. */
  cacheIdentity?: string;
  /** #1748: explicit prompt-cache retention forwarded to pi. Pinned to
   *  "short" by the transport unless the candidate opts into "long". */
  cacheRetention?: CacheRetention;
  /** #1932: state directory for the durable provider-availability memo.
   *  When present, memoizable terminal failures are recorded after Pi's
   *  bounded recovery fails. Write-only and best-effort: memo failures
   *  never break a turn. */
  memoStateDir?: string;
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

/**
 * #1745: classify a provider attempt failure from the terminal `AssistantMessage`
 * pi actually produced. The status classifier runs first; the overflow verdict
 * may reclaim ONLY a `transient` outcome. Widening this — letting overflow
 * displace a definite auth/credits/rate-limit verdict — would let a mistaken
 * verdict reset a live conversation, and a 429 whose text merely mentions
 * tokens would destroy the session. Credits stickiness (#1296), auth demotion
 * and rate-limit cooldown are policy decisions; overflow is a request-shape
 * fact that only the pi predicate (26 provider phrasings, silent and
 * length-stop overflow) can express.
 */
function classifyAttemptFailure(
  terminal: AssistantMessage | undefined,
  contextWindow: number | undefined,
  pi: PiAiModule | undefined,
): { kind: ErrorKind; retryAfterMs?: number } {
  const errorMessage = terminal?.errorMessage ?? "";
  const status = parseErrorStatus(errorMessage);
  const kind = classifyError(status, errorMessage);
  const retryAfterMs = parseRetryAfter(errorMessage);
  if (kind === "transient" && terminal && pi?.isContextOverflow(terminal, contextWindow)) {
    return { kind: "context_exceeded" };
  }
  return { kind, retryAfterMs };
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
): Promise<ProviderAttemptBundle> {
  // #1757: Pi-managed candidates dispatch through Pi's configured runtime
  // (auth resolved by Pi at request time) instead of the abtars-keyed
  // custom provider below.
  if (candidate.authSource === "pi") {
    return createPiManagedAttempt(candidate, model, context, _options, signal);
  }
  const piCandidate: import("./pi-ai-adapter.js").PiAiCandidate = {
    model: candidate.model,
    endpoint: candidate.endpoint,
    apiKey: candidate.apiKey,
    apiFormat: candidate.apiFormat,
    thinking: candidate.thinking,
    maxOutput: model.maxTokens,
    contextWindow: model.contextWindow,
  };
  const bundle = await createPiAiAssistantStream(piCandidate, model, context, _options, signal);
  let terminal: AssistantMessage | undefined;
  let resolveResult: ((message: AssistantMessage) => void) | undefined;
  const resultPromise = new Promise<AssistantMessage>((resolve) => { resolveResult = resolve; });
  async function* iterator(): AsyncGenerator<AssistantMessageEvent> {
    try {
      for await (const event of bundle.stream) {
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
    stream: {
      [Symbol.asyncIterator]: () => iterator(),
      result: () => resultPromise,
    } as unknown as AssistantMessageEventStream,
    // #1745: the narrowed module that created this stream carries the overflow
    // predicate — the execution owner classifies terminal messages through it.
    pi: bundle.pi,
  };
}

/**
 * #1757: attempt factory for Pi-managed candidates. Dispatches through Pi's
 * configured runtime (`streamPiManaged`: request-time auth, no abtars key)
 * with the adapter-built model's reasoning flag carried over for parity.
 * A pre-commit terminal carrying a Pi credential-absence message is mapped
 * to an auth-kind throw so the health path demotes; the runner records the
 * acquisition/streaming failure through the normal classification.
 */
async function createPiManagedAttempt(
  candidate: ModelCandidate,
  model: Model<Api>,
  context: Context,
  _options: SimpleStreamOptions,
  signal: AbortSignal,
): Promise<ProviderAttemptBundle> {
  const { streamPiManaged, isPiAuthAbsenceMessage, PiManagedAuthError } = await import("./pi-runtime.js");
  // Never forward an abtars key on this path — Pi resolves auth internally.
  // Pi-managed candidates carry none, but attempt options are shared shapes.
  const { apiKey: _dropped, ...runtimeOptions } = _options as SimpleStreamOptions & { apiKey?: string };
  const stream = await streamPiManaged(candidate.provider, candidate.model, context, { ...runtimeOptions, signal }, model.reasoning);
  let terminal: AssistantMessage | undefined;
  let resolveResult: ((message: AssistantMessage) => void) | undefined;
  const resultPromise = new Promise<AssistantMessage>((resolve) => { resolveResult = resolve; });
  async function* iterator(): AsyncGenerator<AssistantMessageEvent> {
    try {
      for await (const event of stream) {
        if (event.type === "error") {
          const message = event.error.errorMessage ?? "";
          if (isPiAuthAbsenceMessage(message)) {
            throw new PiManagedAuthError(`Pi-managed request for ${candidate.model} via ${candidate.provider} has no usable Pi auth: ${message}`);
          }
        }
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
  void _dropped;
  return {
    stream: {
      [Symbol.asyncIterator]: () => iterator(),
      result: () => resultPromise,
    } as unknown as AssistantMessageEventStream,
    // No narrowed pi-ai module on this path — status-based classification
    // stays the floor, and auth-absence is mapped to 401 above.
    pi: undefined,
  };
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
  // #1921: Pi 0.86+ calls StreamFn with a TranscriptContext (systemPrompt/tools
  // already folded into the leading system message); abtars-internal callers
  // pass Context. TranscriptContext flows through the Context-typed plumbing
  // below and is normalized idempotently in createPiAiAssistantStream via the
  // loaded pi module — no second transcript is built and no prompt is dropped.
  return (model: Model<Api>, context: Context, fnOptions: SimpleStreamOptions = {}): AssistantMessageEventStream => {
    // #1748: the session-level cache identity is merged here once so the
    // attempt carries it. The retention value is resolved from the single
    // candidate below. Headers are untouched — buildAttemptOptions still
    // owns x-client-request-id per attempt.
    const streamOptions: SimpleStreamOptions = {
      ...fnOptions,
      ...(options.cacheIdentity !== undefined ? { sessionId: options.cacheIdentity } : {}),
      ...(options.cacheRetention !== undefined ? { cacheRetention: options.cacheRetention } : {}),
    };
    const signal = streamOptions.signal ?? new AbortController().signal;
    const outer = async function* (): AsyncGenerator<AssistantMessageEvent> {
      // #1932: single configured candidate, attempted at most once (plus one
      // bounded idempotency-conflict retry). No fallback chain, no rotation,
      // no health-gated skipping — the memo observes failures for future
      // admissions instead of excluding candidates from this turn.
      const candidate = options.candidate;
      let attempted = false;
      // #1745: overflow is a property of THIS request's size, observed for
      // the memo/terminal verdict but never promoted to shared health (which
      // no longer exists).
      let overflowed = false;
      // Classified kind of the attempt's failure, when it failed (never for
      // aborts). Drives the single terminal verdict below.
      let failureKind: ErrorKind | undefined;

      const attemptFactory = options.createPiAiAttempt ?? defaultCreatePiAiAttempt;
      const hasImage = context.messages.some((message) =>
        Array.isArray(message.content)
          && message.content.some((part) => part.type === "image"),
      );
      const piModel = buildPiModel({
        ...candidate,
        contextWindow: candidate.maxContext,
        reasoningEffort: options.reasoningEffort,
        maxOutput: model.maxTokens,
      }, pickPiApi(candidate.apiFormat), hasImage, candidate.provider);

      let attemptCommitted = false;
      let retried = false;
      // #1748: retention belongs to the provider candidate, not the
      // transport. A missing candidate value falls back to the transport
      // option for direct callers and ultimately pins Pi's current default.
      const cacheRetention = candidate.cacheRetention
        ?? options.cacheRetention
        ?? fnOptions.cacheRetention
        ?? "short";

      if (signal.aborted) {
        yield terminalError(model, "aborted", "Execution cancelled");
        return;
      }
      attempted = true;

      while (true) {
        const providerRequestId = (options.providerRequestIdFactory ?? randomUUID)();
        const cacheOptions: SimpleStreamOptions = { ...streamOptions, cacheRetention };
        const attemptOptions = isOpenAiCompatible(piModel.api)
          ? buildAttemptOptions(cacheOptions, providerRequestId)
          : cacheOptions;

        logDebug(TAG, `provider attempt execution=${options.executionId} request=${providerRequestId} candidate=${candidateKey(candidate.model, candidate.endpoint)}`);

        const handle = options.telemetry?.beginProviderCall({
          provider: candidate.provider,
          model: candidate.model,
          candidate: candidateKey(candidate.model, candidate.endpoint),
          startedAt: Date.now(),
        });

        let telemetryEnded = false;
        // #1534: an aborted attempt (operator /stop, execution deadline, or
        // signal cut) is not a candidate failure. A post-cancel continuation
        // turn must still reach the provider.
        // #1297: the actual classification (credits, auth, rate_limit,
        // transient, ...) is recorded, not an unconditional transient.
        // #1932: admission timestamp for stale-success guarding — a
        // success clears only observations not newer than this attempt's
        // admission. Captured here, before any provider await.
        const attemptAdmittedAt = Date.now();
        // #1932: write-only availability observation after the attempt
        // failed. Never throws: a memo write must not break a turn. There
        // is no exclusion set anymore — future admissions consult the memo.
        const observeFailure = (kind: ErrorKind = "transient", retryAfterMs?: number, detail?: string): void => {
          if (options.memoStateDir !== undefined) {
            try {
              recordPiMemoObservation(options.memoStateDir, {
                authNamespace: `${candidate.authSource ?? "abtars"}:${candidate.provider}`,
                provider: candidate.provider,
                endpoint: candidate.endpoint,
                modelScope: candidate.model,
              }, { kind, retryAfterMs }, Date.now());
            } catch { /* best-effort memo write; the turn continues */ }
          }
          // #1905: bounded redacted provider error evidence at the
          // attempt-failure branch — error text only, never prompts.
          logDebug(TAG, `attempt failed execution=${options.executionId} candidate=${candidateKey(candidate.model, candidate.endpoint)} kind=${kind}${detail ? ` error="${detail}"` : ""}`);
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
            // #1932: success clears only same-namespace observations not
            // newer than this attempt's admission; stale completions
            // cannot clear a newer failure. Skips the write when nothing
            // changed so successful turns stay read-only.
            if (options.memoStateDir !== undefined) {
              try {
                const loaded = loadAvailabilityMemo(options.memoStateDir);
                const kept = applyMemoSuccess(loaded.entries, {
                  authNamespace: `${candidate.authSource ?? "abtars"}:${candidate.provider}`,
                  provider: candidate.provider,
                  endpoint: candidate.endpoint,
                  modelScope: candidate.model,
                  admittedAt: attemptAdmittedAt,
                });
                if (kept.length !== loaded.entries.length) {
                  saveAvailabilityMemo(options.memoStateDir, kept);
                }
              } catch { /* best-effort memo clearing; the turn already succeeded */ }
            }
          } else if (result !== "aborted") {
            if (kind !== undefined) failureKind = kind;
            if (kind === "context_exceeded") overflowed = true;
            // #1905: bounded redacted provider error evidence at the
            // attempt-failure branch — error text only, never prompts.
            const failureText = message?.errorMessage ? redactSecrets(message.errorMessage).slice(0, 300) : undefined;
            observeFailure(kind, retryAfterMs, failureText);
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
                const classified = classifyAttemptFailure(terminal, piModel.contextWindow, runner.bundle?.pi);
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
              const classified = classifyAttemptFailure(terminal, piModel.contextWindow, runner.bundle?.pi);
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
              // ends the turn. Operator/deadline cancellation has
              // signal.aborted=true and must not record a failure.
              if (!signal.aborted) observeFailure();
              finishAttempt("aborted", terminal);
              yield terminalError(model, "aborted", `provider_stream_timeout after ${exit.elapsedMs}ms inactivity (semantic output was emitted)`);
              return;
            }
            // #1534: a genuine inactivity stall (the signal was NOT
            // aborted) is still a failure of this attempt; an
            // operator/execution abort is never recorded.
            if (!signal.aborted) observeFailure();
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

      // #1932: single-attempt terminal verdict. The failure kind was
      // classified at the attempt boundary above. Account-limit exhaustion
      // and over-context keep their exact codes; any other genuine failure
      // reports the generic code so spin/sleep observe provider failure
      // instead of a settled domain empty. Abort, cancellation, and
      // committed output return earlier and never reach this branch.
      if (!signal.aborted && attempted) {
        if (failureKind === "credits") {
          options.onTerminalFailure?.({
            code: "credits_exhausted",
            retryable: false,
            attemptedCandidates: 1,
            message: "The configured model is blocked by provider credit exhaustion",
          });
        } else if (failureKind === "context_exceeded" || overflowed) {
          options.onTerminalFailure?.({
            code: "context_overflow",
            retryable: false,
            attemptedCandidates: 1,
            message: "The request exceeds the configured model's context window",
          });
        } else {
          logDebug(TAG, `candidate failed execution=${options.executionId} kind=${failureKind ?? "unclassified"}`);
          options.onTerminalFailure?.({
            code: "all_candidates_failed",
            retryable: false,
            attemptedCandidates: 1,
            message: "The configured model candidate failed",
          });
        }
      }
      yield terminalError(model, signal.aborted ? "aborted" : "error", signal.aborted ? "Execution cancelled" : "The configured model candidate failed");
    };
    return wrapEventStream(outer(), () => assistantMessage(model, [], signal.aborted ? "aborted" : "error", signal.aborted ? "Execution cancelled" : "The configured model candidate failed"));
  };
}
