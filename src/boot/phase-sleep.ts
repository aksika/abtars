/**
 * phase-sleep — boot composition of the sleep capability (#1406, #1706).
 *
 * Two pieces:
 *  - `composeSleep(ctx, client)`: synchronous, idempotent composition. Called
 *    by the boot graph with the boot-time client and again by late memory
 *    publication (#1706). Never registers a duplicate system-task handler.
 *  - a stable `sleep-cycle` dispatcher registered exactly once per process
 *    that reads ctx.sleepHandle / ctx.sleepUnavailable at dispatch time, so
 *    late composition takes effect without re-registration.
 */

import { resetAllCtxStarts } from "./ctx-start.js";
import { logInfo, logWarn } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { getSystemTaskRegistry, type SystemTaskContext } from "../components/tasks/system-task-registry.js";
import { getMasterUserId } from "../components/master-user.js";
import type { AbmindClientLike } from "../components/abmind-client-contract.js";
import { unavailable, createSleepHandle } from "../capabilities/sleep/index.js";

// The system-task registry is process-scoped, while the bridge creates a new
// BootCtx for each in-process /restart generation. Keep the registered handler
// stable, but point it at the current generation's context.
let activeSleepCtx: BootCtx | null = null;

/** Register the stable sleep-cycle dispatcher once per process. The handler
 *  reads current BootCtx state on every dispatch — late composition (#1706)
 *  changes behavior without touching the registry. */
function registerSleepCycleDispatcher(ctx: BootCtx): void {
  activeSleepCtx = ctx;
  const registry = getSystemTaskRegistry();
  if (registry.has("sleep-cycle")) return;
  registry.register("sleep-cycle", async (_entry, taskCtx: SystemTaskContext) => {
    const currentCtx = activeSleepCtx;
    const handle = currentCtx?.sleepHandle;
    if (!handle) {
      return { status: "failed" as const, error: currentCtx?.sleepUnavailable?.reason ?? "sleep not composed" };
    }
    // #1603: the scheduled run settles on the cycle's REAL outcome, not on
    // the dispatch. Progress keeps the run alive past the idle budget.
    const started = handle.startScheduled({ onProgress: () => taskCtx.progress(), signal: taskCtx.signal });
    if (started.status === "already_running") {
      return { status: "noop" as const, detail: "already running" };
    }
    if (started.status === "unavailable") {
      return { status: "failed" as const, error: started.reason };
    }

    // Local handle creation is not daemon admission. Do not wait for or report
    // the cycle outcome until the daemon has accepted this run with a run ID.
    let admission: Awaited<typeof started.admission>;
    try {
      admission = await started.admission;
    } catch {
      return { status: "failed" as const, error: "sleep admission failed: invalid_response" };
    }
    if (admission.status !== "accepted") {
      return { status: "failed" as const, error: `sleep admission rejected: ${admission.reason} (${admission.code})` };
    }
    if (!admission.runId) {
      return { status: "failed" as const, error: "sleep admission failed: invalid_response" };
    }

    const outcome = await started.completion;
    // #1752 R11: essential vs non-essential failures must be reported distinctly
    const ESSENTIAL_STEPS = new Set(["daily-summary", "retrospective", "extract-memories"]);
    const essentialFailed = outcome.failedSteps.filter(s => ESSENTIAL_STEPS.has(s));
    const nonEssentialFailed = outcome.failedSteps.filter(s => !ESSENTIAL_STEPS.has(s));
    const failed = outcome.failedSteps.length > 0 ? ` (failed: ${outcome.failedSteps.join(", ")})` : "";
    const essentialFailedStr = essentialFailed.length > 0 ? ` (failed: ${essentialFailed.join(", ")})` : "";
    const nonEssentialFailedStr = nonEssentialFailed.length > 0 ? ` (failed: ${nonEssentialFailed.join(", ")})` : "";
    switch (outcome.status) {
      case "completed":
        return { status: "ok" as const, detail: "sleep cycle completed" };
      case "partial":
        return { status: "ok" as const, detail: `essential steps completed${failed}` };
      case "no_work":
        return { status: "noop" as const, detail: "no messages since last sleep" };
      case "cancelled":
        return { status: "failed" as const, error: `sleep cycle cancelled${failed}` };
      case "failed": {
        if (essentialFailed.length > 0 && nonEssentialFailed.length > 0) {
          return { status: "failed" as const, error: `sleep steps failed (essential: ${essentialFailed.join(", ")}; non-essential: ${nonEssentialFailed.join(", ")})` };
        }
        if (essentialFailed.length > 0) {
          return { status: "failed" as const, error: `essential sleep steps failed${essentialFailedStr}` };
        }
        if (nonEssentialFailed.length > 0) {
          return { status: "failed" as const, error: `non-essential sleep steps failed${nonEssentialFailedStr}` };
        }
        return { status: "failed" as const, error: `sleep steps failed${failed}` };
      }
      default:
        return { status: "failed" as const, error: `sleep cycle outcome could not be observed${failed}` };
    }
  });
  logInfo("boot", "registered system action sleep-cycle");
}

/** Synchronous, idempotent sleep composition over the current client.
 *  Safe to call again after late memory publication (#1706): an existing
 *  handle short-circuits; a previously unavailable composition upgrades in
 *  place. Never throws into the publication path. */
export function composeSleep(ctx: BootCtx, client: AbmindClientLike | null): void {
  if (ctx.sleepHandle) return; // already composed for this generation

  const { memoryConfig, sendSystemMessage, sessionManager } = ctx;
  ctx.sleepHandle = null;
  ctx.sleepUnavailable = null;

  const markUnavailable = (code: string, reason: string): void => {
    ctx.sleepUnavailable = unavailable(code as never);
    ctx.phaseHealth.set("sleep", { status: "skipped", error: code });
    logWarn("boot", `sleep: not composed — ${reason}`);
  };

  if (!memoryConfig.memoryEnabled) {
    markUnavailable("memory_disabled", "memory disabled");
    return;
  }
  if (!client) {
    markUnavailable("daemon_not_connected", "daemon not connected");
    return;
  }
  if (!sendSystemMessage) {
    markUnavailable("heartbeat_unavailable", "heartbeat not available");
    return;
  }

  const handle = createSleepHandle({
    client,
    memoryEnabled: memoryConfig.memoryEnabled,
    onComplete: () => {
      resetAllCtxStarts(memoryConfig.memoryDir);
    },
    onCycleEnd: () => {
    },
    allocateSleepSession: (name: string) => {
      return sessionManager.allocateDreamySession(name).id;
    },
    sessionManager: {
      spin: async (opts: { type: string; prompt: string; sessionId?: string; timeoutMs: number; deadlineAt: number; providerInactivityTimeoutMs: number; candidatePolicy: "configured-only"; await: true; executionOrigin?: "sleep" }) => {
        // #1611: the pump's absolute provider deadline and configured-only
        // candidate policy flow through to the transport construction.
        // #1651 v2: the awaited contract (result + outcome) passes through
        // unchanged — the pump consumes Spin's classification, never its own.
        return sessionManager.spin({ type: opts.type as any, prompt: opts.prompt, sessionId: opts.sessionId, timeoutMs: opts.timeoutMs, deadlineAt: opts.deadlineAt, providerInactivityTimeoutMs: opts.providerInactivityTimeoutMs, candidatePolicy: opts.candidatePolicy, settlementOwner: "spin", await: true, executionOrigin: opts.executionOrigin });
      },
    },
    // #1611: narrow exact-session quarantine — the capability never sees the
    // full Spin manager. Idempotent; cancels the active execution, releases
    // the persistent transport, and marks the named D session ended.
    quarantineSession: (sessionId: string, reason: string) => {
      sessionManager.finalizeExactSession(sessionId, getMasterUserId(), reason);
    },
    bufferSystemEvent: async (report: string) => {
      const { bufferSystemEvent } = await import("../components/system-event-buffer.js");
      bufferSystemEvent(report);
    },
    // #1653: degraded sleep reports reach Main as a Dreamy agent notice —
    // buffered exactly once, never duplicated through the plain system path.
    bufferAgentNotice: async (from: string, text: string) => {
      const { bufferAgentNotice } = await import("../components/system-event-buffer.js");
      bufferAgentNotice(from, text);
    },
  });
  ctx.sleepHandle = handle;
  ctx.phaseHealth.set("sleep", { status: "ok" });
}

export async function phaseSleep(ctx: BootCtx): Promise<PhaseResult> {
  registerSleepCycleDispatcher(ctx);
  composeSleep(ctx, ctx.client);
  return ctx.sleepHandle ? "ran" : "skipped";
}
