/**
 * memory-recomposition — stable re-composable memory runtime facade (#1706).
 *
 * When the boot-time memory negotiation fails, consumers still capture a
 * single `AbtarsMemoryRuntime` reference for the whole bridge generation.
 * This facade keeps that reference stable while a supervisor retries the
 * composition behind it: every property getter, method, and nested
 * `dreamQuestions` call resolves the current delegate at call time, so an
 * upgrade flips `state` to `"ready"` for every existing holder without any
 * consumer change.
 *
 * Owns no timers and no endpoint knowledge — the supervisor
 * (`MemoryRecompositionSupervisor`, same module) drives retries and calls
 * `upgrade()` exactly once through its publication callback.
 */

import {
  createUnavailableRuntime,
  type AbtarsMemoryRuntime,
  type MemoryCompositionDiagnostics,
  type MemoryCompositionFailureCode,
} from "./memory-runtime.js";
import { logWarn, logTrace, logInfo } from "./logger.js";
import type { AbmindClientLike } from "./abmind-client-contract.js";

const TAG = "memory-recomposition";

/** Boot-independent composition result. `phase-memory.ts` re-exports this
 *  under its historical `MemoryRuntimeFactoryResult` name. */
export interface CompositionAttemptResult {
  mode: "local" | "wss";
  client: AbmindClientLike;
  runtime: AbtarsMemoryRuntime;
  abmindModule: typeof import("abmind") | null;
}

/** Owner-facing control surface. Consumers only ever see `.runtime`. */
export interface RecomposableMemoryRuntimeController {
  readonly runtime: AbtarsMemoryRuntime;
  /** Install the negotiated delegate. Returns false (and closes nothing) when
   *  the facade was already upgraded; the caller must dispose the rejected
   *  runtime. */
  upgrade(runtime: AbtarsMemoryRuntime): boolean;
  /** Replace the bounded diagnostics snapshot (immutable copies kept). */
  setDiagnostics(snapshot: MemoryCompositionDiagnostics): void;
}

export class RecomposableMemoryRuntime implements RecomposableMemoryRuntimeController {
  readonly runtime: AbtarsMemoryRuntime;

  private inner: AbtarsMemoryRuntime;
  private upgraded = false;
  private closed = false;
  private rejectedSecondUpgradeLogged = false;
  private diagnostics: MemoryCompositionDiagnostics = { state: "idle", attempts: 0 };

  constructor(initial: AbtarsMemoryRuntime = createUnavailableRuntime()) {
    this.inner = initial;
    const resolve = (): AbtarsMemoryRuntime => this.inner;
    const self = this;

    this.runtime = {
      get state() { return resolve().state; },
      get capabilities() { return resolve().capabilities; },
      get routeSnapshot() { return resolve().routeSnapshot; },
      get compositionDiagnostics() { return { ...self.diagnostics }; },

      supports: (...args) => resolve().supports(...args),
      recordMessage: (input, operationKey) => resolve().recordMessage(input, operationKey),
      recall: (input) => resolve().recall(input),
      assembleSessionContext: (input) => resolve().assembleSessionContext(input),
      getRecentConversation: (input) => resolve().getRecentConversation(input),
      getStatus: (input) => resolve().getStatus(input),
      getSleepStatus: () => resolve().getSleepStatus(),
      getCoreKnowledge: (input) => resolve().getCoreKnowledge(input),
      recordFeedback: (input, operationKey) => resolve().recordFeedback(input, operationKey),
      embed: (input) => resolve().embed(input),
      runMaintenance: (input) => resolve().runMaintenance(input),
      instantStore: (input) => resolve().instantStore(input),
      editMemory: (input) => resolve().editMemory(input),
      rebuildFtsIndexes: () => resolve().rebuildFtsIndexes(),
      projectDurableContext: (input) => resolve().projectDurableContext(input),
      prepareConversationCompaction: (input) => resolve().prepareConversationCompaction(input),
      commitConversationCompaction: (input, operationKey) => resolve().commitConversationCompaction(input, operationKey),

      // Stable nested object: a consumer that captures `facade.dreamQuestions`
      // before the upgrade must not retain the unavailable delegate.
      dreamQuestions: {
        nextPending: (...args) => resolve().dreamQuestions.nextPending(...args),
        list: (...args) => resolve().dreamQuestions.list(...args),
        markAsked: (...args) => resolve().dreamQuestions.markAsked(...args),
        dismiss: (...args) => resolve().dreamQuestions.dismiss(...args),
      },

      findSealedSecrets: (input) => resolve().findSealedSecrets(input),
      resolveSealedSecret: (input) => resolve().resolveSealedSecret(input),

      close: async () => {
        if (self.closed) return;
        self.closed = true;
        await resolve().close();
      },
    };
  }

  upgrade(runtime: AbtarsMemoryRuntime): boolean {
    if (this.upgraded) {
      if (!this.rejectedSecondUpgradeLogged) {
        this.rejectedSecondUpgradeLogged = true;
        logWarn(TAG, "upgrade rejected: memory runtime already composed");
      }
      return false;
    }
    this.upgraded = true;
    this.inner = runtime;
    return true;
  }

  setDiagnostics(snapshot: MemoryCompositionDiagnostics): void {
    this.diagnostics = { ...snapshot };
  }
}

/** Production scheduler: one `.unref()`-ed `setTimeout`, clear function returned.
 *  No interval, no heartbeat task (#1666 timer ownership). */
export function createUnrefTimeoutScheduler(): (fn: () => void, delayMs: number) => () => void {
  return (fn, delayMs) => {
    const t = setTimeout(fn, delayMs);
    t.unref();
    return () => clearTimeout(t);
  };
}

export interface MemoryRecompositionSupervisorDeps {
  /** One full composition attempt: resolve endpoint config fresh, apply local
   *  package-layout checks, negotiate. Owned by the boot layer. */
  attempt: () => Promise<CompositionAttemptResult>;
  /** Map an attempt failure to the closed bounded code union. Injected to
   *  avoid a component→boot import (architecture inversion). */
  classifyFailure: (error: unknown) => MemoryCompositionFailureCode;
  /** Synchronous publication of a successful attempt (facade upgrade, ctx
   *  ownership, live health). Never called after cancellation. */
  publish: (result: CompositionAttemptResult) => void;
  /** Close a result that must never be published (post-cancel success). */
  dispose: (result: CompositionAttemptResult) => Promise<void>;
  /** Receives an immutable snapshot on every diagnostics mutation. */
  onDiagnostics: (snapshot: MemoryCompositionDiagnostics) => void;
  /** Injectable timer; production uses `createUnrefTimeoutScheduler()`. */
  schedule?: (fn: () => void, delayMs: number) => () => void;
  now?: () => number;
  /** Escalating intervals between attempts; defaults to 5s/15s/60s. */
  delaysMs?: readonly number[];
  /** Interval for all attempts after `delaysMs` is exhausted. */
  repeatDelayMs?: number;
}

const DEFAULT_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000];
const DEFAULT_REPEAT_DELAY_MS = 120_000;

/** Single-flight retry loop for late memory composition (#1706).
 *
 *  State machine: `idle → retrying → upgraded | cancelled`. Created idle by
 *  `phaseMemory`; `startBridge` arms the first timer only after `bootGraph`
 *  has finalized its report into `ctx.phaseHealth`, so diagnostics callbacks
 *  can never lose an update to graph finalization. */
export class MemoryRecompositionSupervisor {
  private readonly deps: Required<Pick<MemoryRecompositionSupervisorDeps, "attempt" | "classifyFailure" | "publish" | "dispose" | "onDiagnostics" | "schedule" | "now" | "delaysMs" | "repeatDelayMs">>;
  private diag: MemoryCompositionDiagnostics = { state: "idle", attempts: 0 };
  private clearTimer: (() => void) | null = null;
  private inFlight: Promise<void> | null = null;
  private cancelled = false;
  private started = false;
  private finished = false;

  constructor(deps: MemoryRecompositionSupervisorDeps) {
    this.deps = {
      attempt: deps.attempt,
      classifyFailure: deps.classifyFailure,
      publish: deps.publish,
      dispose: deps.dispose,
      onDiagnostics: deps.onDiagnostics,
      schedule: deps.schedule ?? createUnrefTimeoutScheduler(),
      now: deps.now ?? Date.now,
      delaysMs: deps.delaysMs ?? DEFAULT_DELAYS_MS,
      repeatDelayMs: deps.repeatDelayMs ?? DEFAULT_REPEAT_DELAY_MS,
    };
  }

  get diagnostics(): MemoryCompositionDiagnostics {
    return { ...this.diag };
  }

  private emit(): void {
    this.deps.onDiagnostics({ ...this.diag });
  }

  private transition(state: MemoryCompositionDiagnostics["state"]): void {
    this.diag = { ...this.diag, state };
    this.emit();
  }

  /** Arms the first retry timer. Idempotent; a cancelled supervisor never arms. */
  start(): void {
    if (this.started) {
      logTrace(TAG, "start ignored: already started");
      return;
    }
    this.started = true;
    if (this.cancelled) {
      logTrace(TAG, "start ignored: supervisor already cancelled");
      this.transition("cancelled");
      return;
    }
    this.transition("retrying");
    this.arm(0);
  }

  private arm(attemptIndex: number): void {
    const delay = attemptIndex < this.deps.delaysMs.length
      ? this.deps.delaysMs[attemptIndex]!
      : this.deps.repeatDelayMs;
    this.clearTimer?.();
    this.clearTimer = this.deps.schedule(() => {
      this.clearTimer = null;
      void this.runAttempt(attemptIndex);
    }, delay);
    logTrace(TAG, `retry armed in ${delay}ms (attempt #${attemptIndex + 1})`);
  }

  private async runAttempt(attemptIndex: number): Promise<void> {
    if (this.finished || this.cancelled) return;

    // Coalesced tick while an attempt is in flight: wait for it, then keep
    // the chain alive unless the completed attempt already rearmed/finished.
    if (this.inFlight) {
      try { await this.inFlight; } catch { /* failures are handled in-flight */ }
      if (this.finished || this.cancelled) return;
      if (!this.clearTimer) this.arm(attemptIndex);
      return;
    }

    const run = (async () => {
      this.diag = { ...this.diag, attempts: this.diag.attempts + 1, lastAttemptAt: this.deps.now() };
      this.emit();
      let result: CompositionAttemptResult;
      try {
        result = await this.deps.attempt();
      } catch (err) {
        const code = this.deps.classifyFailure(err);
        this.diag = { ...this.diag, lastFailure: code };
        this.emit();
        if (this.cancelled) return;
        // WARN only at backoff-tier escalation boundaries; steady-state 120s
        // failures stay TRACE (#1706 log policy).
        const atTierBoundary = attemptIndex === 0 || attemptIndex + 1 === this.deps.delaysMs.length;
        if (atTierBoundary) {
          logWarn(TAG, `memory composition attempt ${this.diag.attempts} failed (${code})`);
        } else {
          logTrace(TAG, `memory composition attempt ${this.diag.attempts} failed (${code})`);
        }
        if (!this.finished) this.arm(attemptIndex + 1);
        return;
      }
      if (this.cancelled) {
        // Shutdown wins: the negotiated client is closed, never published.
        try {
          await this.deps.dispose(result);
          logTrace(TAG, "in-flight composition succeeded after cancel — result disposed");
        } catch (err) {
          logWarn(TAG, `dispose after cancel failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      this.finished = true;
      this.clearTimer?.();
      this.clearTimer = null;
      this.diag = { ...this.diag, state: "upgraded", upgradedAt: this.deps.now() };
      this.emit();
      logInfo(TAG, "memory composition succeeded — publishing negotiated runtime");
      this.deps.publish(result);
    })();
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = null;
    }
  }

  /** Marks cancellation synchronously (clears the pending timer), then drains
   *  an in-flight attempt so shutdown can proceed with bounded latency. */
  async cancel(): Promise<void> {
    if (!this.cancelled) {
      this.cancelled = true;
      this.clearTimer?.();
      this.clearTimer = null;
      if (this.diag.state !== "upgraded") this.transition("cancelled");
    }
    if (this.inFlight) await this.inFlight;
  }
}
