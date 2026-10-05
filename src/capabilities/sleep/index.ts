import type { AbmindClientLike } from "../../components/abmind-client-contract.js";
import type { ToolExecutionScope } from "../../components/tasks/task-package.js";
import { abtarsHome } from "../../paths.js";
import { statSync, realpathSync } from "node:fs";
import { getEnv } from "../../components/env-schema.js";
import { logInfo, logWarn, logError, redactSecrets } from "../../components/logger.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";
import { PiCoreToolExecutionError } from "../../components/transport/tool-failure-diagnostic.js";

const TAG = "sleep";

const SLEEP_FAILURE_CAUSES: ReadonlySet<string> = new Set([
  "provider_failed", "provider_timeout", "step_deadline", "invalid_response",
  "prompt_round_limit", "candidate_round_limit", "candidate_exhausted", "policy_rejected",
  "nonzero_exit", "spawn_error", "timeout", "aborted", "shell_syntax_error", "repeated_failure",
  "memory_validation", "memory_not_found", "memory_conflict", "memory_unauthorized",
  "memory_idempotency_conflict", "memory_unavailable", "memory_outcome_unknown",
  "completion_settlement_failed", "service_failed", "unknown",
]);

type SleepFailurePayload = {
  cause: string;
  detail?: string;
  commandFingerprint?: string;
  /** #1912: normalized execution facts for abmind supervision. Validated
   *  here so malformed host facts can never widen into a replay permit. */
  failureClass?: "transient" | "permanent" | "cancelled" | "unavailable" | "unknown";
  retryAfterMs?: number;
  reachedModel?: boolean;
  effects?: "absent" | "reconcilable" | "unknown";
  reasonCode?: string;
};

const FAILURE_CLASSES: ReadonlySet<string> = new Set(["transient", "permanent", "cancelled", "unavailable", "unknown"]);
const EXECUTION_EFFECTS: ReadonlySet<string> = new Set(["absent", "reconcilable", "unknown"]);

/** Normalize provider/tool diagnostics before they cross the host boundary. */
function boundedSleepFailure(input: unknown): SleepFailurePayload {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const cause = typeof raw["cause"] === "string" && SLEEP_FAILURE_CAUSES.has(raw["cause"])
    ? raw["cause"]
    : "unknown";
  const detail = typeof raw["detail"] === "string" ? redactSecrets(raw["detail"]).slice(0, 240) : undefined;
  const commandFingerprint = typeof raw["commandFingerprint"] === "string" && /^[0-9a-f]{16}$/i.test(raw["commandFingerprint"])
    ? raw["commandFingerprint"]
    : undefined;
  const failureClass = typeof raw["failureClass"] === "string" && FAILURE_CLASSES.has(raw["failureClass"])
    ? raw["failureClass"] as SleepFailurePayload["failureClass"]
    : undefined;
  const retryAfterMs = typeof raw["retryAfterMs"] === "number" && Number.isSafeInteger(raw["retryAfterMs"]) && raw["retryAfterMs"] > 0
    ? Math.min(raw["retryAfterMs"], 3_600_000)
    : undefined;
  const reachedModel = typeof raw["reachedModel"] === "boolean" ? raw["reachedModel"] : undefined;
  const effects = typeof raw["effects"] === "string" && EXECUTION_EFFECTS.has(raw["effects"])
    ? raw["effects"] as SleepFailurePayload["effects"]
    : undefined;
  const reasonCode = typeof raw["reasonCode"] === "string" && raw["reasonCode"].length > 0
    ? redactSecrets(raw["reasonCode"]).slice(0, 80)
    : undefined;
  return {
    cause,
    ...(detail ? { detail } : {}),
    ...(commandFingerprint ? { commandFingerprint } : {}),
    ...(failureClass ? { failureClass } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(reachedModel !== undefined ? { reachedModel } : {}),
    ...(effects ? { effects } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

/**
 * #1912: host-side execution-failure classification. The pump normalizes
 * provider-specific failures into bounded facts for broker fail() so abmind
 * supervision can decide recovery in code. An arbitrary provider error is
 * never proof of a justified blocker.
 */
function classifyHostFailure(message: string, opts?: { reachedModel?: boolean }): Pick<SleepFailurePayload, "failureClass" | "reachedModel" | "effects" | "reasonCode"> {
  const msg = message.toLowerCase();
  const has = (...needles: string[]): boolean => needles.some(n => msg.includes(n));
  const reached = opts?.reachedModel;
  // Completion calls return proposal text; durable writes happen only
  // through validated revision-checked apply, so re-issue is reconcilable.
  const effects = "reconcilable" as const;
  if (has("cancelled", "abort", "cancelled before daemon start")) {
    return { failureClass: "cancelled", ...(reached !== undefined ? { reachedModel: reached } : {}), effects };
  }
  if (has("401", "unauthorized", "unauthenticated", "forbidden", "403", "credit", "billing", "quota", "insufficient", "payment", "policy_rejected", "capability_mismatch", "permission denied")) {
    return { failureClass: "permanent", ...(reached !== undefined ? { reachedModel: reached } : {}), effects, reasonCode: "auth-policy" };
  }
  if (has("429", "rate limit", "503", "502", "504", "overload", "temporarily", "try again", "timeout", "timed out", "deadline", "etime", "econn", "refused", "reset", "network", "socket hang up")) {
    return { failureClass: "transient", ...(reached !== undefined ? { reachedModel: reached } : {}), effects };
  }
  return { failureClass: "unknown", ...(reached !== undefined ? { reachedModel: reached } : {}), effects: "unknown" };
}

import { writeSleepStatus } from "../../components/transport/bridge-lock-transport.js";
import { buildPolicy, type SandboxPolicy } from "../../components/tool-sandbox.js";
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
   * #1807: explicit host execution scope for every sleep spin. Composed at
   * the sleep boundary (phase-sleep); when absent the handle resolves the
   * verified runtime-home default below — daemon cwd is never inherited.
   */
  executionScope?: ToolExecutionScope;
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
  sessionManager: { spin: (opts: { type: string; prompt: string; sessionId?: string; timeoutMs: number; deadlineAt: number; providerInactivityTimeoutMs: number; candidatePolicy: "configured-only"; settlementOwner: "spin" | "caller"; await: true; executionOrigin?: "sleep"; executionScope?: ToolExecutionScope; tools?: SandboxPolicy }) => Promise<import("../../components/spin-types.js").AwaitedSpinResult> };
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

export type SleepAdmissionCode =
  | "runtime_open_failed"
  | "cancelled"
  | "transport_error"
  | "not_found"
  | "not_resumable"
  | "already_running"
  | "unavailable"
  | "invalid_response";

export type SleepAdmission =
  | { status: "accepted"; runId: string }
  | {
      status: "rejected";
      code: SleepAdmissionCode;
      reason: string;
    };

export type SleepStartResult =
  | { status: "accepted"; admission: Promise<SleepAdmission>; completion: Promise<SleepCycleOutcome> }
  | { status: "already_running" }
  | SleepUnavailable;

export function unavailable(code: SleepUnavailableCode): SleepUnavailable {  const reasons: Record<SleepUnavailableCode, string> = {
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
 * #1859: proposal-only turn policy. Only tools known to be read-only remain
 * available; every write-capable route (Bash, CLI, memory store/edit, file
 * and task mutations) is withheld before generation and re-checked at
 * dispatch. `execute_bash` can never be certified read-only by inspection,
 * so it is denied here.
 */
export const PROPOSAL_ONLY_TOOLS: Readonly<SandboxPolicy> = buildPolicy("peer", { allowedTools: ["memory_recall"] });

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

/**
 * #1807: backstop scope resolution. The boundary (phase-sleep) always
 * composes an explicit scope; when absent the verified runtime-home default
 * applies. Daemon cwd is never a fallback — an unverifiable home is an
 * explicit error before any tool execution.
 */
export function defaultSleepScope(): { scope: ToolExecutionScope } | { error: string } {
  try {
    const home = abtarsHome();
    if (!statSync(home).isDirectory()) return { error: `abtars home is not a directory: ${home}` };
    const cwd = realpathSync(home);
    return { scope: { cwd, env: Object.freeze({ WORKSPACE: cwd }) } };
  } catch (err) {
    return { error: `abtars home unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function createSleepHandle(opts: SleepOpts): SleepHandle {
  const { client } = opts;
  let running = false;
  let progress: SleepProgress | null = null;
  let currentRunId: string | null = null;
  let abortController = new AbortController();
  let nightSessionId: string | undefined;
  // #1807: cycle-owned execution scope, set in startRun, consumed by the
  // provider pump. Cleared with the session identity at cycle end.
  let cycleExecutionScope: ToolExecutionScope | undefined;

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
    cycleExecutionScope = undefined;
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
  function normalizeSleepFailure(err: unknown, fallbackCode: "provider_failed" | "provider_timeout"): SleepFailurePayload {
    let cur: unknown = err;
    const seen = new Set<unknown>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const structuredFailure = (cur as { failure?: unknown })?.failure;
      if (structuredFailure !== undefined) {
        return boundedSleepFailure(structuredFailure);
      }
      if (cur instanceof PiCoreToolExecutionError) {
        const d = cur.diagnostic;
        const cause = d.reason;
        const detail = (d.stderr_excerpt ?? d.command_preview ?? cur.message)?.slice(0, 240);
        const fp = d.command_fingerprint;
        return boundedSleepFailure({ cause, detail, commandFingerprint: fp });
      }
      const diag = (cur as { diagnostic?: { reason?: string; command_preview?: string; command_fingerprint?: string; stderr_excerpt?: string } })?.diagnostic;
      if (diag?.reason) {
        const cause = diag.reason;
        const detail = (diag.stderr_excerpt ?? diag.command_preview ?? (cur as Error).message)?.slice(0, 240);
        return boundedSleepFailure({ cause, detail, commandFingerprint: diag.command_fingerprint });
      }
      const next = (cur as { cause?: unknown })?.cause;
      if (next && next !== cur) { cur = next; continue; }
      break;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const detail = msg.slice(0, 240);
    return boundedSleepFailure({ cause: fallbackCode === "provider_timeout" ? "provider_timeout" : "unknown", detail });
  }

  /**
   * #1912: recoverable completion-failure settlement. Fences and quarantines
   * an unsafe execution/session, settles that exact completion once with
   * normalized facts, and — unless the run is over — keeps polling so
   * abmind supervision can re-issue bounded further work on a healthy
   * session. A fenced session is replaced lazily: the next spin allocates
   * without the quarantined id. Returns "stop" only when polling itself
   * must end (cancellation); every other outcome returns "continue".
   */
  async function settleCompletionFailure(
    leaseId: string,
    req: { completionId: string; runId: string; stepId: string; deadline: number },
    code: "provider_timeout" | "provider_failed",
    detail: string,
    opts?: { fenceSession?: boolean; failureOverride?: SleepFailurePayload; stopPump?: boolean },
  ): Promise<"continue" | "stop"> {
    const safeDetail = redactSecrets(detail).slice(0, 240);
    if (opts?.fenceSession) {
      // Fence first, then give the broker failure RPC only the remaining
      // absolute deadline. A dead daemon must not keep the local pump alive.
      quarantineCurrentSession(code);
    }
    const failure = boundedSleepFailure(opts?.failureOverride ?? normalizeSleepFailure(new Error(detail), code));
    logWarn("sleep", `Sleep provider failure (run=${req.runId} step=${req.stepId} lease=${leaseId}): ${safeDetail} — ${opts?.fenceSession ? "quarantining session, " : ""}failing completion ${code}`);
    const failResult = await runUntilDeadline(
      () => (client.sleep.runtime as unknown as { fail: (a: string, b: string, c: string, d?: unknown) => Promise<unknown> }).fail(leaseId, req.completionId, code, failure),
      settlementDeadlineAt(req.deadline),
    );
    if (failResult.kind !== "settled") {
      logWarn("sleep", `Runtime failure settlement did not complete before the deadline (run=${req.runId} step=${req.stepId})`);
    }
    return opts?.stopPump === true ? "stop" : "continue";
  }

  async function providerPump(leaseId: string): Promise<void> {
    try {
      let nextRpcErrors = 0;
      while (!abortController.signal.aborted) {
        let nextResult: Awaited<ReturnType<AbmindClientLike["sleep"]["runtime"]["next"]>>;
        try {
          nextResult = await client.sleep.runtime.next(leaseId, RUNTIME_NEXT_WAIT_MS);
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
          // No execution started — the session is healthy. Fail with
          // transient facts and keep serving; supervision re-issues.
          await settleCompletionFailure(leaseId, req, "provider_timeout", "provider window already exhausted", {
            failureOverride: { cause: "provider_timeout", detail: "provider window already exhausted", failureClass: "transient", reachedModel: false, effects: "absent", reasonCode: "timeout" },
          });
          continue;
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
              executionOrigin: "sleep",
              executionScope: cycleExecutionScope,
              // #1859: a proposal-only step runs with every write-capable
              // tool withheld; abmind applies only validated proposals.
              ...(req.proposalOnly === true ? { tools: PROPOSAL_ONLY_TOOLS } : {}),
            }),
            providerRemainingMs,
          );
        } catch (err) {
          // spin() itself rejected before any execution started under this
          // session — the session is healthy, so it is kept. Fail with
          // normalized facts and keep serving; supervision decides recovery.
          if (abortController.signal.aborted) {
            await settleCompletionFailure(leaseId, req, "provider_failed", (err as Error).message, {
              fenceSession: true,
              failureOverride: { cause: "aborted", detail: "sleep cancelled during provider execution", failureClass: "cancelled", reachedModel: false, effects: "unknown" },
              stopPump: true,
            });
            break;
          }
          const facts = classifyHostFailure((err as Error).message, { reachedModel: false });
          await settleCompletionFailure(leaseId, req, "provider_failed", (err as Error).message, {
            failureOverride: { ...normalizeSleepFailure(err, "provider_failed"), ...facts },
          });
          continue;
        }
        if (spinResult.kind === "timed_out") {
          // The execution may still be live provider-side — fence the
          // session (a replacement is allocated lazily on the next spin),
          // fail once, and keep serving. A late result can never settle
          // after fencing: the broker owns exact-completion settlement.
          if (await settleCompletionFailure(leaseId, req, "provider_timeout", "deadline reached while awaiting the model", {
            fenceSession: true,
            failureOverride: { cause: "provider_timeout", detail: "deadline reached while awaiting the model", failureClass: "transient", effects: "unknown", reasonCode: "timeout" },
          }) === "stop") break;
          continue;
        }
        if (spinResult.kind === "failed") {
          // The execution finished with an error — nothing is pending, so
          // the session is healthy and kept. Whether the model was reached
          // is unknown from a rejection alone: fail with normalized facts
          // and let supervision charge conservatively.
          const facts = classifyHostFailure(spinResult.error.message);
          await settleCompletionFailure(leaseId, req, "provider_failed", spinResult.error.message, {
            failureOverride: { ...normalizeSleepFailure(spinResult.error, "provider_failed"), ...facts },
          });
          continue;
        }
        if (spinResult.value.sessionId && !nightSessionId) nightSessionId = spinResult.value.sessionId;
        // #1611: a transport terminal error with no valid semantic result
        // must reject the completion — never complete(""), which would look
        // like a domain retry and hide the provider failure. Kept as a
        // defensive check at this external boundary even though the typed
        // facade requires the field.
        if (spinResult.value.result === undefined) {
          // Indeterminate execution outcome — fence the session (a
          // replacement allocates lazily), fail once, keep serving.
          // Never complete(""), which would hide the provider failure.
          await settleCompletionFailure(leaseId, req, "provider_failed", "spin settled without a semantic result", {
            fenceSession: true,
            failureOverride: { cause: "invalid_response", detail: "spin settled without a semantic result", failureClass: "unknown", effects: "unknown" },
          });
          continue;
        }
        // #1651 v2 narrows #1611: rejection, timeout and a missing result field
        // are still terminal (handled above). A turn that SETTLED with no
        // textual content is a domain fact, so it settles as an empty
        // completion and abmind's sendToRuntime applies its own bounded empty
        // retry (MAX_DOMAIN_RETRIES → terminal invalid_response). Only text is
        // curation content; a reaction is a chat control signal, never sleep
        // domain output. The outcome is Spin's own classification — the pump
        // never recomputes one from the raw string.
        const outcome = spinResult.value.outcome;
        const completion = outcome === "text" ? spinResult.value.result : "";
        if (outcome !== "text") {
          logWarn("sleep", `Step ${req.stepId} produced no text content (${outcome}) — settling as an empty completion for abmind's domain retry`);
        }

        const completeResult = await runUntilDeadline(
          () => {
            const c = client.sleep.runtime.complete as unknown as (a: string, b: string, c: string, d?: string, e?: string) => Promise<{ status: string }>;
            return outcome === "text" ? c(leaseId, req.completionId, completion) : c(leaseId, req.completionId, completion, outcome);
          },
          settlementDeadlineAt(req.deadline),
        );
        if (completeResult.kind === "timed_out") {
          // The execution finished; only broker reporting timed out. Its
          // state is unknown — abmind reconciles via its deadline path — so
          // the healthy session is kept and the pump keeps serving.
          await settleCompletionFailure(leaseId, req, "provider_timeout", "completion settlement reached the broker deadline", {
            failureOverride: { cause: "completion_settlement_failed", detail: "completion settlement reached the broker deadline", failureClass: "transient", reachedModel: true, effects: "reconcilable", reasonCode: "settlement" },
          });
          continue;
        }
        if (completeResult.kind === "failed") {
          await settleCompletionFailure(leaseId, req, "provider_failed", completeResult.error.message, {
            failureOverride: { ...normalizeSleepFailure(completeResult.error, "provider_failed"), failureClass: "transient", reachedModel: true, effects: "reconcilable" },
          });
          continue;
        }
        if (completeResult.value.status !== "ok") {
          // #1912: the broker already fenced our completion (stale or
          // superseded) — failing the dead id again is noise. Our execution
          // finished, the session is healthy, and abmind re-issues through
          // supervision, so the pump keeps serving.
          logWarn("sleep", `Completion rejected (${completeResult.value.status}) for ${req.completionId} (run=${req.runId} step=${req.stepId} lease=${leaseId}) — keeping session, continuing to poll`);
          continue;
        }
      }
    } catch (err) {
      logError("sleep", "Runtime provider pump error", err);
    } finally {
      // #1681: the pump owns the handed-off lease — it closes it exactly once
      // on every terminal path. A close failure is best-effort; the cycle has
      // already settled.
      try { await client.sleep.runtime.close(leaseId); } catch { /* best effort */ }
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
    // #1807: resolve the execution scope before any state changes. No scope
    // means no cycle — reported here, never as daemon-cwd inheritance.
    const resolved = opts.executionScope ? { scope: opts.executionScope } : defaultSleepScope();
    if ("error" in resolved) {
      const reason = `sleep execution scope unavailable: ${resolved.error}`;
      logWarn("sleep", `Sleep did not start (unavailable): ${reason}`);
      return { status: "unavailable", code: "sleep_not_initialized", reason };
    }
    const executionScope = resolved.scope;
    cycleExecutionScope = executionScope;
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

    let admissionResolve: (v: SleepAdmission) => void = () => {};
    const admission = new Promise<SleepAdmission>((resolve) => { admissionResolve = resolve; });
    let admissionSettled = false;
    const settleAdmission = (v: SleepAdmission): void => {
      if (admissionSettled) return;
      admissionSettled = true;
      admissionResolve(v);
    };

    /** #1681: pre-handoff failure/cancellation cleanup — settle the local
     *  outcome truthfully, restore sleep state, finalize the session, and
     *  fire onCycleEnd exactly once. Never starts a daemon run. */
    const finishBeforeRun = (outcome: SleepCycleOutcome["status"], detail: string): void => {
      settle({ status: outcome, failedSteps: [], report: undefined });
      cleanup();
      try { opts.onCycleEnd?.(); } catch (err) { logWarn("sleep", `onCycleEnd callback threw: ${(err as Error).message}`); }
      logWarn("sleep", `Sleep did not start (${outcome}): ${detail}`);
    };

    /** Close a lease acquired during bootstrap. A close failure is observed
     *  and logged but never hides the original start/open outcome. */
    const closeOwnedLease = async (leaseId: string): Promise<void> => {
      try {
        await client.sleep.runtime.close(leaseId);
      } catch (err) {
        logWarn("sleep", `Lease close failed during pre-run cleanup (lease=${leaseId}): ${(err as Error).message}`);
      }
    };

    const failureMessage = (err: unknown): string => {
      let raw: string;
      try { raw = err instanceof Error ? err.message : String(err); }
      catch { raw = "sleep admission transport error"; }
      return redactSecrets(raw).slice(0, 240) || "sleep admission transport error";
    };
    const boundedAdmissionReason = (reason: unknown): string => {
      let raw: string;
      try { raw = typeof reason === "string" ? reason : String(reason); }
      catch { raw = "unknown"; }
      return redactSecrets(raw).slice(0, 240) || "unknown";
    };

    const mapRejectionCode = (status: string): SleepAdmissionCode => {
      switch (status) {
        case "already_running": return "already_running";
        case "not_found": return "not_found";
        case "not_resumable": return "not_resumable";
        case "unavailable": return "unavailable";
        default: return "transport_error";
      }
    };

    /** #1681: the accepted cycle starts its event poller and provider pump
     *  together, as before; the pump now owns a lease that was already opened
     *  by the bootstrap. */
    const runAcceptedCycle = (runId: string, pump: Promise<void>): void => {
      currentRunId = runId;
      const failedSteps: string[] = [];
      const poller = eventPoller(options?.onProgress, failedSteps).catch(() => null);
      Promise.all([pump, poller]).finally(async () => {
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
        try { opts.onCycleEnd?.(); } catch (err) { logWarn("sleep", `onCycleEnd callback threw: ${(err as Error).message}`); }
      });
    };

    // #1681: acquire and validate the runtime-provider lease BEFORE issuing
    // sleep.start/sleep.resume. The daemon must observe hasProvider true by
    // the time the first model-backed step can be dispatched. The bootstrap
    // owns the lease until the daemon accepts a run with a runId; every
    // pre-handoff exit closes an acquired lease, and only then is the lease
    // handed to the pump (whose existing terminal finally path closes it).
    const bootstrap = async (): Promise<void> => {
      let leaseId: string | undefined;
      let leaseHandedToPump = false;
      try {
        const opened = await client.sleep.runtime.open("abtars", undefined, { proposalOnly: true });
        if (opened.status !== "ok" || !opened.leaseId) {
          const reason = `runtime open failed: ${opened.status}`;
          settleAdmission({ status: "rejected", code: "runtime_open_failed", reason });
          finishBeforeRun("unknown", reason);
          return;
        }
        leaseId = opened.leaseId;

        // #1681: a cancellation that landed before the daemon start/resume
        // request is issued must not start a daemon run — close the lease and
        // settle the local outcome as cancelled.
        if (abortController.signal.aborted) {
          await closeOwnedLease(leaseId);
          leaseId = undefined;
          const reason = "cancelled before daemon start";
          settleAdmission({ status: "rejected", code: "cancelled", reason });
          finishBeforeRun("cancelled", reason);
          return;
        }

        const result = mode === "resume"
          ? await client.sleep.resume(undefined, level)
          : await client.sleep.start(mode, level, fresh);

        const validRunId = typeof result.runId === "string" && result.runId.length > 0 && result.runId.length <= 128;
        if (result.status !== "accepted" || !validRunId) {
          const code = result.status === "accepted" && !validRunId ? "invalid_response" : mapRejectionCode(result.status);
          const reason = boundedAdmissionReason(result.reason ?? `sleep not accepted: ${result.status}`);
          settleAdmission({ status: "rejected", code, reason });
          await closeOwnedLease(leaseId);
          leaseId = undefined;
          finishBeforeRun("unknown", reason);
          return;
        }

        const runId = result.runId as string;
        settleAdmission({ status: "accepted", runId });
        leaseHandedToPump = true;
        runAcceptedCycle(runId, providerPump(leaseId));
      } catch (err) {
        const reason = failureMessage(err);
        settleAdmission({ status: "rejected", code: "transport_error", reason });
        if (leaseId && !leaseHandedToPump) await closeOwnedLease(leaseId);
        finishBeforeRun("unknown", reason);
      }
    };

    void bootstrap();

    return { status: "accepted", admission, completion };
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
