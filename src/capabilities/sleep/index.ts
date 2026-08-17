import type { AbmindClientLike } from "../../components/abmind-client-contract.js";
import { getEnv } from "../../components/env-schema.js";
import { logInfo, logWarn, logError } from "../../components/logger.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";

const TAG = "sleep";
import { writeSleepStatus } from "../../components/transport/bridge-lock-transport.js";
import { startSleepCard, type SleepCard } from "./sleep-card.js";
import type { CapabilityApi } from "../capability.js";

export type SleepUnavailableCode =
  | "memory_disabled"
  | "abmind_not_loaded"
  | "daemon_not_connected"
  | "heartbeat_unavailable"
  | "sleep_not_initialized";

export interface SleepUnavailable {
  status: "unavailable";
  code: SleepUnavailableCode;
  reason: string;
}

export interface SleepOpts {
  client: AbmindClientLike;
  memoryEnabled: boolean;
  onComplete: () => void;
  onCycleEnd?: () => void;
  /**
   * #1538: allocate the one named D session that owns the whole cycle and
   * return its id. The cycle requires the identity — a discarded id makes the
   * first provider generation allocate a second, unnamed sibling session.
   */
  allocateSleepSession?: (name: string) => string | undefined;
  /**
   * #1651 v2: the awaited spin contract is preserved through the facade —
   * `result` and `outcome` are required on every settled turn. The pump
   * consumes Spin's classification; it never recomputes one from the raw
   * string.
   */
  sessionManager: { spin: (opts: { type: string; prompt: string; sessionId?: string; timeoutMs: number; deadlineAt: number; providerInactivityTimeoutMs: number; candidatePolicy: "configured-only"; settlementOwner: "spin" | "caller"; await: true }) => Promise<import("../../components/spin-types.js").AwaitedSpinResult> };
  /**
   * #1611: narrow exact-session quarantine callback. Fences the session by
   * exact id, cancels the active execution, releases the persistent
   * transport, and marks it ended. Idempotent; never awaits the provider.
   * The reason is the stable terminal label ("provider_timeout" /
   * "provider_failed" / "cycle_end").
   */
  quarantineSession?: (sessionId: string, reason: string) => void | Promise<void>;
  /**
   * #1653: ordinary report delivery — every non-degraded report is enqueued
   * exactly once through this path.
   */
  bufferSystemEvent: (report: string) => void | Promise<void>;
  /**
   * #1653: degraded-report delivery — `partial` and `failed` reports are
   * routed through the agent-notice channel exactly once and NEVER through
   * bufferSystemEvent. Required in production types on purpose: a missing
   * wiring must not silently fall back to the plain path.
   */
  bufferAgentNotice: (from: string, text: string) => void | Promise<void>;
}

/**
 * The cycle's real outcome, observed from the daemon (#1603). The scheduled
 * run settles from this instead of from the dispatch itself.
 */
export interface SleepCycleOutcome {
  /** abmind's terminal status, or "unknown" when it could not be observed. */
  status: "completed" | "no_work" | "partial" | "failed" | "cancelled" | "unknown";
  /** Step ids observed failing during the cycle (from step_failed events). */
  failedSteps: readonly string[];
  /** abmind's run report, capped by the daemon. */
  report?: string;
}

/** Host-side run options for a sleep start (#1603). */
export interface SleepStartOptions {
  onProgress?: () => void;
  signal?: AbortSignal;
}

export type SleepStartResult =
  | { status: "accepted"; completion: Promise<SleepCycleOutcome> }
  | { status: "already_running" }
  | SleepUnavailable;

export function unavailable(code: SleepUnavailableCode): SleepUnavailable {
  const reasons: Record<SleepUnavailableCode, string> = {
    memory_disabled: "memory is disabled",
    abmind_not_loaded: "abmind did not initialize during boot",
    daemon_not_connected: "abmind daemon is not connected",
    heartbeat_unavailable: "heartbeat is unavailable",
    sleep_not_initialized: "sleep did not initialize during boot",
  };
  return { status: "unavailable", code, reason: reasons[code] };
}

export interface SleepProgress {
  percent: number;
  step: string;
}

export interface SleepHandle {
  readonly isActive: boolean;
  readonly progress: SleepProgress | null;
  startScheduled(options?: SleepStartOptions): SleepStartResult;
  startManual(options: { fresh: boolean; resume: boolean }, runOptions?: SleepStartOptions): SleepStartResult;
}

const POLL_INTERVAL_MS = 3000;
const EVENTS_LIMIT = 50;
/**
 * The provider pump's long-poll bound. Must stay BELOW the daemon transport's
 * REQUEST_TIMEOUT_MS (30s): a poll that sits exactly on the transport timeout
 * races it, and a lost race surfaces as a fatal pump error, killing the cycle
 * (#1603 recovery finding, 2026-08-07).
 */
const RUNTIME_NEXT_WAIT_MS = 25_000;
/** Bounded backoff before giving up on a transient next() RPC failure. */
const NEXT_RPC_RETRY_LIMIT = 10;
const NEXT_RPC_RETRY_DELAY_MS = 3000;

/**
 * #1611: reserved before the logical step deadline for exact-session
 * quarantine, broker failure settlement, and run shutdown. Mirrors the
 * contract value owned by abmind (sleep/step-deadlines.ts) — abtars cannot
 * import abmind at runtime.
 */
const SLEEP_PROVIDER_CLEANUP_HEADROOM_MS = 30_000;

/**
 * #1517: bounds the provider pump's await on the model transport by the
 * broker's absolute completion deadline. The transport receives the remaining
 * bound and should abort at it; when it ignores cancellation, this race still
 * terminates the pump so the sleep handle can clean up and a later cycle can
 * open a fresh lease. The broker remains authoritative: a stale completion is
 * rejected there regardless of this race.
 */
type DeadlineRaceResult<T> =
  | { kind: "settled"; value: T }
  | { kind: "timed_out" }
  | { kind: "failed"; error: Error };

async function runWithAbsoluteDeadline<T>(spin: Promise<T>, remainingMs: number): Promise<DeadlineRaceResult<T>> {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve({ kind: "timed_out" });
    }, Math.max(1, remainingMs));
    spin.then((value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ kind: "settled", value });
    }).catch((err: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ kind: "failed", error: err instanceof Error ? err : new Error(String(err)) });
    });
  });
}

/** Run a local/RPC operation without allowing settlement to outlive the
 * caller-owned absolute deadline. The operation is started even when the
 * deadline has already elapsed, but its result is deliberately ignored. */
async function runUntilDeadline<T>(operation: () => Promise<T> | T, deadlineAt: number): Promise<DeadlineRaceResult<T>> {
  const operationPromise = Promise.resolve().then(operation);
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    void operationPromise.catch(err => logAndSwallow(TAG, "deadline-expired operation", err));
    return { kind: "timed_out" };
  }
  return runWithAbsoluteDeadline(operationPromise, remainingMs);
}

/** Settlement is allowed to use the logical deadline, but never more than the
 * reserved cleanup window. This keeps a dead broker from holding the local
 * sleep pump for an entire logical step after the provider has failed. */
function settlementDeadlineAt(logicalDeadlineAt: number): number {
  return Math.min(logicalDeadlineAt, Date.now() + SLEEP_PROVIDER_CLEANUP_HEADROOM_MS);
}

export function createSleepHandle(opts: SleepOpts): SleepHandle {
  const { client } = opts;
  let running = false;
  let progress: SleepProgress | null = null;
  let currentRunId: string | null = null;
  let abortController = new AbortController();
  let nightSessionId: string | undefined;

  /** Fence and request exact-session quarantine synchronously. The callback is
   * local lifecycle work; do not let an optional async implementation delay
   * broker failure settlement or cycle shutdown. */
  function quarantineCurrentSession(reason: string): void {
    const sessionId = nightSessionId;
    if (!sessionId) return;
    try {
      const pending = opts.quarantineSession?.(sessionId, reason);
      if (pending && typeof (pending as Promise<void>).catch === "function") {
        void (pending as Promise<void>).catch(err => logAndSwallow(TAG, "quarantine night session during termination", err));
      }
    } catch (err) { logAndSwallow(TAG, "quarantine night session during termination", err); }
    nightSessionId = undefined;
  }

  function cleanup(): void {
    running = false;
    progress = null;
    currentRunId = null;
    // #1538: the cycle's D identity does not outlive the cycle. A retained id
    // would make the next cycle pump into a reaped session while its own
    // freshly named session sat idle.
    // #1611: a healthy named Dreamy session is finalized exactly once at cycle
    // end (idempotent — a failed run already quarantined it in the pump).
    quarantineCurrentSession("cycle_end");
    writeSleepStatus("awake");
  }

  /**
   * #1611: terminal provider-failure sequence. Quarantines the exact Dreamy
   * session, fails the pending broker completion once with a stable code,
   * clears the cycle's session id, and stops the pump — regardless of the
   * fail RPC outcome. No later completion is polled and no replacement
   * session is allocated.
   */
  async function terminateOnFailure(
    leaseId: string,
    req: { completionId: string; runId: string; stepId: string; deadline: number },
    code: "provider_timeout" | "provider_failed",
    detail: string,
  ): Promise<void> {
    logWarn("sleep", `Sleep provider failure (run=${req.runId} step=${req.stepId} lease=${leaseId}): ${detail} — quarantining session, failing completion ${code}, stopping sleep`);
    // Fence first, then give the broker failure RPC only the remaining
    // absolute deadline. A dead daemon must not keep the local pump alive.
    quarantineCurrentSession(code);
    const failResult = await runUntilDeadline(
      () => client.sleep.runtime.fail(leaseId, req.completionId, code),
      settlementDeadlineAt(req.deadline),
    );
    if (failResult.kind !== "settled") {
      logWarn("sleep", `Runtime failure settlement did not complete before the deadline (run=${req.runId} step=${req.stepId})`);
    }
  }

  async function providerPump(): Promise<void> {
    let ownedLeaseId: string | undefined;
    try {
      const openResult = await client.sleep.runtime.open("abtars");
      if (openResult.status !== "ok" || !openResult.leaseId) {
        logWarn("sleep", `Runtime provider open failed: ${openResult.status}`);
        return;
      }
      ownedLeaseId = openResult.leaseId;

      let nextRpcErrors = 0;
      while (!abortController.signal.aborted && ownedLeaseId) {
        let nextResult: Awaited<ReturnType<AbmindClientLike["sleep"]["runtime"]["next"]>>;
        try {
          nextResult = await client.sleep.runtime.next(ownedLeaseId, RUNTIME_NEXT_WAIT_MS);
        } catch (err) {
          // #1603 recovery finding: a transient RPC failure on the long-poll
          // must not kill a healthy cycle — the daemon may simply have had a
          // slow heartbeat. Retry with backoff; give up only on sustained loss.
          nextRpcErrors++;
          if (nextRpcErrors >= NEXT_RPC_RETRY_LIMIT) {
            logWarn("sleep", `Runtime next() failed ${nextRpcErrors} times in a row — closing provider pump`);
            break;
          }
          logWarn("sleep", `Runtime next() RPC failed (${nextRpcErrors}/${NEXT_RPC_RETRY_LIMIT}) — retrying in ${NEXT_RPC_RETRY_DELAY_MS}ms: ${(err as Error).message}`);
          await new Promise(r => setTimeout(r, NEXT_RPC_RETRY_DELAY_MS));
          continue;
        }
        nextRpcErrors = 0;
        if (nextResult.status === "closed" || nextResult.status === "lease_expired") break;
        if (nextResult.heartbeat) continue;
        if (nextResult.status === "no_request") continue;

        const req = nextResult.completionRequest;
        if (!req) continue;

        // #1611: the provider executes inside the broker deadline minus the
        // 30s cleanup headroom reserved for quarantine, failure settlement,
        // and run shutdown.
        const providerDeadlineAt = req.deadline - SLEEP_PROVIDER_CLEANUP_HEADROOM_MS;
        const providerRemainingMs = providerDeadlineAt - Date.now();
        if (providerRemainingMs <= 0) {
          await terminateOnFailure(ownedLeaseId, req, "provider_timeout", "provider window already exhausted");
          break;
        }

        let spinResult: DeadlineRaceResult<import("../../components/spin-types.js").AwaitedSpinResult>;
        try {
          spinResult = await runWithAbsoluteDeadline(
            opts.sessionManager.spin({
              type: "D",
              prompt: req.prompt,
              sessionId: nightSessionId,
              timeoutMs: providerRemainingMs,
              deadlineAt: providerDeadlineAt,
              providerInactivityTimeoutMs: providerRemainingMs,
              candidatePolicy: "configured-only",
              settlementOwner: "spin",
              await: true,
            }),
            providerRemainingMs,
          );
        } catch (err) {
          // spin() itself rejected before/while opening the transport —
          // terminal for the logical step.
          await terminateOnFailure(ownedLeaseId, req, "provider_failed", (err as Error).message);
          break;
        }
        if (spinResult.kind === "timed_out") {
          await terminateOnFailure(ownedLeaseId, req, "provider_timeout", "deadline reached while awaiting the model");
          break;
        }
        if (spinResult.kind === "failed") {
          await terminateOnFailure(ownedLeaseId, req, "provider_failed", spinResult.error.message);
          break;
        }
        if (spinResult.value.sessionId && !nightSessionId) nightSessionId = spinResult.value.sessionId;
        // #1611: a transport terminal error with no valid semantic result
        // must reject the completion — never complete(""), which would look
        // like a domain retry and hide the provider failure. Kept as a
        // defensive check at this external boundary even though the typed
        // facade requires the field.
        if (spinResult.value.result === undefined) {
          await terminateOnFailure(ownedLeaseId, req, "provider_failed", "spin settled without a semantic result");
          break;
        }
        // #1651 v2 narrows #1611: rejection, timeout and a missing result field
        // are still terminal (handled above). A turn that SETTLED with no
        // textual content is a domain fact, so it settles as an empty
        // completion and abmind's sendToRuntime applies its own bounded empty
        // retry (MAX_DOMAIN_RETRIES → terminal invalid_response). Only text is
        // curation content; a reaction is a chat control signal, never sleep
        // domain output. The outcome is Spin's own classification — the pump
        // never recomputes one from the raw string.
        const completion = spinResult.value.outcome === "text" ? spinResult.value.result : "";
        if (spinResult.value.outcome !== "text") {
          logWarn("sleep", `Step ${req.stepId} produced no text content (${spinResult.value.outcome}) — settling as an empty completion for abmind's domain retry`);
        }

        const completeResult = await runUntilDeadline(
          () => client.sleep.runtime.complete(ownedLeaseId!, req.completionId, completion),
          settlementDeadlineAt(req.deadline),
        );
        if (completeResult.kind === "timed_out") {
          await terminateOnFailure(ownedLeaseId, req, "provider_timeout", "completion settlement reached the broker deadline");
          break;
        }
        if (completeResult.kind === "failed") {
          await terminateOnFailure(ownedLeaseId, req, "provider_failed", completeResult.error.message);
          break;
        }
        if (completeResult.value.status !== "ok") {
          // #1611: ok, invalid_completion, or a fail-RPC error all lead to
          // pump shutdown — nothing authorizes polling for another completion.
          const code = Date.now() >= req.deadline ? "provider_timeout" : "provider_failed";
          quarantineCurrentSession(code);
          logWarn("sleep", `Completion rejected (${completeResult.value.status}) for ${req.completionId} (run=${req.runId} step=${req.stepId} lease=${ownedLeaseId}) — quarantining session and stopping sleep`);
          break;
        }
      }
    } catch (err) {
      logError("sleep", "Runtime provider pump error", err);
    } finally {
      if (ownedLeaseId) {
        try { await client.sleep.runtime.close(ownedLeaseId); } catch { /* best effort */ }
        ownedLeaseId = undefined;
      }
    }
  }

  async function eventPoller(onProgress: (() => void) | undefined, failedSteps: string[]): Promise<string | null> {
    let afterSeq = 0;
    let sleepCard: SleepCard | null = null;
    let observedTerminal: string | null = null;

    while (!abortController.signal.aborted && currentRunId && !observedTerminal) {
      try {
        const eventsResult = await client.sleep.events(afterSeq, EVENTS_LIMIT, POLL_INTERVAL_MS);
        currentRunId = eventsResult.runId;

        if (!sleepCard && eventsResult.events.length > 0) {
          sleepCard = startSleepCard();
        }

        for (const ev of eventsResult.events) {
          // The server returns events with seq > afterSeq, so keep the last
          // seen sequence number rather than skipping the next event.
          afterSeq = ev.seq;
          if (ev.event.type === "cycle_started") {
            progress = { percent: 0, step: "starting" };
          }
          if (ev.event.type === "step_started") {
            progress = {
              percent: "totalSteps" in ev.event ? Math.round((ev.seq / (ev.event as any).totalSteps) * 100) : 50,
              step: ev.event.detail ?? "running",
            };
          }
          if (ev.event.type === "step_failed" && ev.event.detail) {
            failedSteps.push(ev.event.detail);
          }
          if (ev.event.type === "cycle_finished") {
            observedTerminal = ev.event.detail ?? null;
          }
          sleepCard?.onEvent({ seq: ev.seq, at: ev.at, type: ev.event.type, detail: ev.event.detail } as any);
        }

        if (eventsResult.events.length > 0) onProgress?.();

        if (eventsResult.terminal) {
          break;
        }
      } catch {
        break;
      }
    }

    sleepCard?.complete();
    return observedTerminal ?? null;
  }

  function startRun(mode: "scheduled" | "manual" | "resume", level: string, fresh: boolean | undefined, options?: SleepStartOptions): SleepStartResult {
    if (running) return { status: "already_running" };
    running = true;
    progress = { percent: 0, step: "starting" };
    abortController = new AbortController();
    writeSleepStatus("sleeping");
    logInfo("sleep", `😴 Sleep starting (mode=${mode}, client-backed)`);

    // #1603: host cancellation (scheduled-run terminal) propagates into the
    // cycle's internal abort controller.
    const externalSignal = options?.signal;
    const onExternalAbort = (): void => abortController.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abortController.abort(externalSignal.reason);
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    if (opts.allocateSleepSession) {
      const dateStr = new Date().toISOString().slice(0, 10);
      // #1538: hold the allocated identity — every provider generation in this
      // cycle pumps into it instead of allocating an unnamed sibling.
      nightSessionId = opts.allocateSleepSession(`Sleep ${dateStr}`);
    }

    let settleCompletion: (outcome: SleepCycleOutcome) => void = () => {};
    const completion = new Promise<SleepCycleOutcome>((resolve) => { settleCompletion = resolve; });
    let settled = false;
    const settle = (outcome: SleepCycleOutcome): void => {
      if (settled) return;
      settled = true;
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
      settleCompletion(outcome);
    };

    const startPromise = mode === "resume"
      ? client.sleep.resume(undefined, level)
      : client.sleep.start(mode, level, fresh);

    startPromise.then((result: { status: string; runId?: string; reason?: string }) => {
      if (result.status === "accepted" && result.runId) {
        currentRunId = result.runId;
        const failedSteps: string[] = [];
        const poller = eventPoller(options?.onProgress, failedSteps).catch(() => null);
        Promise.all([
          providerPump(),
          poller,
        ]).finally(async () => {
          // #1603: resolve the outcome — the observed cycle_finished event
          // first, then the daemon's own status (which also carries the
          // report), then "unknown" when neither is available.
          const observed = await poller;
          const terminalSet: ReadonlySet<string> = new Set(["completed", "no_work", "partial", "failed", "cancelled"]);
          let status: SleepCycleOutcome["status"] = observed && terminalSet.has(observed) ? observed as SleepCycleOutcome["status"] : "unknown";
          let report: string | undefined;
          try {
            const st = await client.sleep.status();
            if (!observed && st.last?.status) status = st.last.status as SleepCycleOutcome["status"];
            report = st.last?.report;
          } catch { /* status unavailable */ }
          const outcome: SleepCycleOutcome = { status, failedSteps: [...failedSteps], report };
          // Deliver the report and fire onComplete BEFORE the host's awaited
          // completion resolves, so the scheduled run settles only after its
          // side channels are drained. Host callbacks are wrapped so a
          // throwing host cannot change the outcome.
          // #1653: exactly-once delivery — degraded outcomes (partial/failed)
          // go to the Dreamy agent-notice channel, every other report uses the
          // plain system-event path. The branches are mutually exclusive; the
          // two APIs share one buffer, so routing a report through both would
          // duplicate Main context.
          try {
            if (outcome.report) {
              if (outcome.status === "partial" || outcome.status === "failed") {
                await opts.bufferAgentNotice("dreamy", outcome.report);
              } else {
                await opts.bufferSystemEvent(outcome.report);
              }
            }
          } catch (err) { logWarn("sleep", `Report delivery failed: ${(err as Error).message}`); }
          try {
            if (outcome.status === "completed" || outcome.status === "partial" || outcome.status === "no_work") opts.onComplete();
          } catch (err) { logWarn("sleep", `onComplete callback threw: ${(err as Error).message}`); }
          settle(outcome);
          cleanup();
          opts.onCycleEnd?.();
        });
      } else {
        settle({ status: "unknown", failedSteps: [], report: undefined });
        cleanup();
        opts.onCycleEnd?.();
        logWarn("sleep", `Sleep not accepted: ${result.status}${result.reason ? ": " + result.reason : ""}`);
      }
    }).catch((err: unknown) => {
      settle({ status: "unknown", failedSteps: [], report: undefined });
      cleanup();
      opts.onCycleEnd?.();
      logWarn("sleep", `Sleep start failed: ${(err as Error).message}`);
    });

    return { status: "accepted", completion };
  }

  return {
    get isActive() { return running; },
    get progress() { return progress; },
    startScheduled(options?: SleepStartOptions): SleepStartResult {
      const env = getEnv();
      const level = env.sleepQuality ?? "normal";
      return startRun("scheduled", level, undefined, options);
    },
    startManual({ fresh, resume }, runOptions?): SleepStartResult {
      const env = getEnv();
      const level = fresh ? "ultimate" : (env.sleepQuality ?? "normal");
      return startRun(resume ? "resume" : "manual", level, fresh, runOptions);
    },
  };
}

export function register(_api: CapabilityApi): void {
}
