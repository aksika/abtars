import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { logDebug } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import type { ModelCandidate } from "./model-candidates.js";

const TAG = "provider-attempt-runner";

/** #1506: One whole provider attempt — acquisition AND streaming — owned by a
 *  single liveness guard armed before the first external await. */
export type ProviderAttemptFactory = (
  candidate: ModelCandidate,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  signal: AbortSignal,
) => Promise<AssistantMessageEventStream>;

export type ProviderAttemptPhase = "acquiring" | "streaming" | "terminal" | "cleanup";

export type ProviderAttemptExit =
  | { kind: "event"; event: AssistantMessageEvent }
  | { kind: "ended" }
  | { kind: "timeout"; phase: "acquiring" | "streaming"; elapsedMs: number }
  | { kind: "aborted"; phase: "acquiring" | "streaming" }
  | { kind: "failed"; phase: "acquiring" | "streaming"; error: unknown };

export interface ProviderAttemptRunnerOptions {
  executionId: string;
  requestId: string;
  candidate: ModelCandidate;
  model: Model<Api>;
  context: Context;
  /** Base stream options WITHOUT the candidate-local signal — the runner
   *  injects its own attempt signal so the provider request is aborted when
   *  the attempt times out or the execution aborts. */
  options: SimpleStreamOptions;
  attemptFactory: ProviderAttemptFactory;
  /** Execution-level abort signal (operator /stop, scheduled deadline, ...). */
  signal: AbortSignal;
  /** Absolute execution deadline epoch ms; inactivity bound is capped by it. */
  deadlineAt?: number;
  /** Configured per-event inactivity bound (default 180_000). */
  inactivityTimeoutMs: number;
  now?: () => number;
  /** Observability: phase transition (acquiring → streaming → terminal). */
  onPhase?: (phase: ProviderAttemptPhase) => void;
}

interface AcquireOutcome {
  kind: "acquired" | "failed";
  stream?: AssistantMessageEventStream;
  error?: unknown;
}

type GuardOutcome = { kind: "timeout" } | { kind: "aborted" };

interface ArmedGuard {
  guard: Promise<GuardOutcome>;
  cleanup: () => void;
}

/**
 * #1506: single owner of provider-attempt liveness. Constructed (and its
 * abort/deadline/inactivity scope armed) BEFORE `attemptFactory` is invoked —
 * no provider await precedes the guard. Races acquisition and every iterator
 * read through the same scope, produces exactly one terminal exit, and
 * detaches unresolved factory/iterator cleanup so a late settlement can never
 * publish, commit the candidate, or delay logical terminalization.
 */
export class ProviderAttemptRunner {
  private readonly opts: ProviderAttemptRunnerOptions;
  private readonly attemptController: AbortController;
  private readonly attemptSignal: AbortSignal;
  private readonly now: () => number;
  private removeOuterAbortListener: (() => void) | null = null;
  private _phase: ProviderAttemptPhase = "acquiring";

  constructor(opts: ProviderAttemptRunnerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.attemptController = new AbortController();
    if (opts.signal.aborted) {
      this.attemptController.abort();
    } else {
      const onOuterAbort = (): void => this.attemptController.abort();
      opts.signal.addEventListener("abort", onOuterAbort, { once: true });
      this.removeOuterAbortListener = () => opts.signal.removeEventListener("abort", onOuterAbort);
    }
    this.attemptSignal = this.attemptController.signal;
  }

  get phase(): ProviderAttemptPhase {
    return this._phase;
  }

  /** Candidate-local abort signal shared with the provider request. */
  get signal(): AbortSignal {
    return this.attemptSignal;
  }

  private setPhase(phase: ProviderAttemptPhase): void {
    this._phase = phase;
    this.opts.onPhase?.(phase);
  }

  /** Configured inactivity bound capped by the remaining absolute deadline. */
  private inactivityMs(): number {
    if (this.opts.deadlineAt === undefined) return this.opts.inactivityTimeoutMs;
    return Math.max(0, Math.min(this.opts.inactivityTimeoutMs, this.opts.deadlineAt - this.now()));
  }

  /**
   * Arm a fresh inactivity/abort guard. Must be called BEFORE the provider
   * work it protects (attempt factory invocation or the next iterator read) so
   * no external await can precede the scope.
   */
  private armGuard(): ArmedGuard {
    let cleanup: (() => void) | null = null;
    const guard = new Promise<GuardOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        timer = undefined;
        resolve({ kind: "timeout" });
      }, this.inactivityMs());
      const onAbort = (): void => {
        if (timer) clearTimeout(timer);
        resolve({ kind: "aborted" });
      };
      if (this.attemptSignal.aborted) {
        if (timer) clearTimeout(timer);
        resolve({ kind: "aborted" });
        return;
      }
      this.attemptSignal.addEventListener("abort", onAbort, { once: true });
      cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        this.attemptSignal.removeEventListener("abort", onAbort);
      };
    });
    return {
      guard,
      cleanup: () => cleanup?.(),
    };
  }

  private async closeIteratorBestEffort(iterator: AsyncIterator<AssistantMessageEvent>): Promise<void> {
    try {
      const ret = iterator.return?.();
      if (ret) await Promise.resolve(ret).catch((err) => logAndSwallow(TAG, "late iterator return rejected", err));
    } catch (err) {
      logAndSwallow(TAG, "invoke late iterator return", err);
    }
  }

  private async closeStreamBestEffort(stream: AssistantMessageEventStream): Promise<void> {
    try {
      const iterator = stream[Symbol.asyncIterator]();
      await this.closeIteratorBestEffort(iterator);
    } catch (err) {
      logAndSwallow(TAG, "close late provider stream", err);
    }
  }

  /**
   * Observe an unresolved acquisition promise after timeout/abort. A later
   * rejection is consumed (never an unhandled rejection) and a later stream is
   * closed best-effort — it can never publish or be committed.
   */
  private detachAcquisition(acquired: Promise<AcquireOutcome>): void {
    void acquired.then((result) => {
      if (result.kind === "acquired" && result.stream) {
        return this.closeStreamBestEffort(result.stream);
      }
      return undefined;
    }).catch((err) => {
      logAndSwallow(TAG, "late provider acquisition rejected", err);
    });
  }

  async *run(): AsyncGenerator<ProviderAttemptExit> {
    const startedAt = this.now();
    try {
      // ── acquiring ─────────────────────────────────────────────────────────
      this.setPhase("acquiring");
      logDebug(TAG, `provider_attempt_acquiring execution=${this.opts.executionId} request=${this.opts.requestId} candidate=${this.opts.candidate.model}`);

      // Guard armed BEFORE the factory is invoked — the escaped acquisition gap.
      const acquireGuard = this.armGuard();
      // The factory promise is observed (never an unhandled rejection) and its
      // terminal value races the guard that was armed before invocation.
      const acquiredPromise: Promise<AcquireOutcome> = Promise.resolve().then(() => this.opts.attemptFactory(
        this.opts.candidate,
        this.opts.model,
        this.opts.context,
        { ...this.opts.options, signal: this.attemptSignal },
        this.attemptSignal,
      )).then(
        (stream) => ({ kind: "acquired" as const, stream }),
        (error) => ({ kind: "failed" as const, error }),
      );
      const acquireOutcome = await Promise.race([acquiredPromise, acquireGuard.guard]);
      acquireGuard.cleanup();

      if (acquireOutcome.kind === "aborted") {
        this.detachAcquisition(acquiredPromise);
        this.setPhase("terminal");
        yield { kind: "aborted", phase: "acquiring" };
        return;
      }
      if (acquireOutcome.kind === "timeout") {
        this.detachAcquisition(acquiredPromise);
        this.attemptController.abort();
        this.setPhase("terminal");
        yield { kind: "timeout", phase: "acquiring", elapsedMs: this.now() - startedAt };
        return;
      }
      // acquireOutcome.kind === "failed" | "acquired"
      if (acquireOutcome.kind === "failed") {
        this.setPhase("terminal");
        yield { kind: "failed", phase: "acquiring", error: acquireOutcome.error };
        return;
      }
      const stream = acquireOutcome.stream;
      if (!stream) {
        this.setPhase("terminal");
        yield { kind: "failed", phase: "acquiring", error: new Error("attempt factory resolved without a stream") };
        return;
      }

      // ── streaming ─────────────────────────────────────────────────────────
      this.setPhase("streaming");
      logDebug(TAG, `provider_attempt_streaming execution=${this.opts.executionId} request=${this.opts.requestId} candidate=${this.opts.candidate.model}`);
      let iterator: AsyncIterator<AssistantMessageEvent>;
      try {
        iterator = stream[Symbol.asyncIterator]();
      } catch (err) {
        this.setPhase("terminal");
        yield { kind: "failed", phase: "streaming", error: err };
        return;
      }

      try {
        while (true) {
          // Guard armed BEFORE the next provider read begins.
          const nextGuard = this.armGuard();
          const nextPromise = Promise.resolve().then(() => iterator.next());
          // The next() outcome is observed so a late rejection is consumed even
          // if the guard wins the race.
          const nextSettled: Promise<
            { kind: "settled"; value: IteratorResult<AssistantMessageEvent> } | { kind: "failed"; error: unknown }
          > = nextPromise.then(
            (value) => ({ kind: "settled" as const, value }),
            (error) => ({ kind: "failed" as const, error }),
          );
          const outcome = await Promise.race([nextSettled, nextGuard.guard]);
          nextGuard.cleanup();

          if (outcome.kind === "aborted") {
            this.detachPending(nextPromise);
            this.setPhase("terminal");
            yield { kind: "aborted", phase: "streaming" };
            return;
          }
          if (outcome.kind === "timeout") {
            this.detachPending(nextPromise);
            this.attemptController.abort();
            this.setPhase("terminal");
            yield { kind: "timeout", phase: "streaming", elapsedMs: this.now() - startedAt };
            return;
          }
          if (outcome.kind === "failed") {
            this.detachPending(nextPromise);
            this.setPhase("terminal");
            yield { kind: "failed", phase: "streaming", error: outcome.error };
            return;
          }
          // outcome.kind === "settled"
          if (outcome.value.done) {
            this.setPhase("terminal");
            yield { kind: "ended" };
            return;
          }
          // Every event (including non-semantic progress) resets the inactivity
          // guard on the next iteration.
          yield { kind: "event", event: outcome.value.value };
        }
      } finally {
        // Best-effort close, never awaited on the logical path. The explicit
        // detach calls above only observe the pending next(); the iterator
        // close is idempotent and safe to run on every exit, including an
        // early consumer break after a terminal event.
        void this.closeIteratorBestEffort(iterator).catch((err) => logAndSwallow(TAG, "close iterator on teardown", err));
      }
    } finally {
      this.removeOuterAbortListener?.();
      this.removeOuterAbortListener = null;
    }
  }

  /** Observe a pending iterator.next() so a late rejection is never unhandled. */
  private detachPending(pending: Promise<unknown>): void {
    void Promise.resolve(pending).catch((err) => logAndSwallow(TAG, "late iterator.next rejected", err));
  }
}
