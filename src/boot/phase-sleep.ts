import { resetAllCtxStarts } from "./ctx-start.js";
import { logInfo, logWarn } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { getSystemTaskRegistry, type SystemTaskContext } from "../components/tasks/system-task-registry.js";

function registerUnavailableHandler(reason: string): void {
  const registry = getSystemTaskRegistry();
  if (!registry.has("sleep-cycle")) {
    registry.register("sleep-cycle", () => ({ status: "failed", error: reason }));
  }
}

export async function phaseSleep(ctx: BootCtx): Promise<PhaseResult> {
  const { memoryConfig, sendSystemMessage, sessionManager } = ctx;
  const { unavailable, createSleepHandle } = await import("../capabilities/sleep/index.js");

  ctx.sleepHandle = null;
  ctx.sleepUnavailable = null;

  if (!memoryConfig.memoryEnabled) {
    ctx.sleepUnavailable = unavailable("memory_disabled");
    ctx.phaseHealth.set(phaseSleep.name, { status: "skipped", error: "memory disabled" });
    logWarn("boot", `${phaseSleep.name}: skipping — memory disabled`);
    registerUnavailableHandler(ctx.sleepUnavailable.reason);
    return "skipped";
  }

  if (!ctx.client) {
    ctx.sleepUnavailable = unavailable("daemon_not_connected");
    ctx.phaseHealth.set(phaseSleep.name, { status: "skipped", error: "daemon not connected" });
    logWarn("boot", `${phaseSleep.name}: skipping — daemon not connected`);
    registerUnavailableHandler(ctx.sleepUnavailable.reason);
    return "skipped";
  }

  if (!sendSystemMessage) {
    ctx.sleepUnavailable = unavailable("heartbeat_unavailable");
    ctx.phaseHealth.set(phaseSleep.name, { status: "skipped", error: "no sendSystemMessage" });
    logWarn("boot", `${phaseSleep.name}: skipping — heartbeat not available`);
    registerUnavailableHandler(ctx.sleepUnavailable.reason);
    return "skipped";
  }

  const handle = createSleepHandle({
    client: ctx.client,
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
      spin: async (opts: { type: string; prompt: string; sessionId?: string; timeoutMs: number; await: boolean }) => {
        return sessionManager.spin({ type: opts.type as any, prompt: opts.prompt, sessionId: opts.sessionId, timeoutMs: opts.timeoutMs, settlementOwner: "spin", await: true });
      },
    },
    bufferSystemEvent: async (report: string) => {
      const { bufferSystemEvent } = await import("../components/system-event-buffer.js");
      bufferSystemEvent(report);
    },
  });
  ctx.sleepHandle = handle;

  const registry = getSystemTaskRegistry();
  if (!registry.has("sleep-cycle")) {
    registry.register("sleep-cycle", async (_entry, ctx: SystemTaskContext) => {
      // #1603: the scheduled run settles on the cycle's REAL outcome, not on
      // the dispatch. Progress keeps the run alive past the idle budget.
      const started = handle.startScheduled({ onProgress: () => ctx.progress(), signal: ctx.signal });
      if (started.status === "already_running") {
        return { status: "noop" as const, detail: "already running" };
      }
      if (started.status === "unavailable") {
        return { status: "failed" as const, error: started.reason };
      }

      const outcome = await started.completion;
      const failed = outcome.failedSteps.length > 0 ? ` (failed: ${outcome.failedSteps.join(", ")})` : "";
      switch (outcome.status) {
        case "completed":
          return { status: "ok" as const, detail: "sleep cycle completed" };
        case "partial":
          return { status: "ok" as const, detail: `essential steps completed${failed}` };
        case "no_work":
          return { status: "noop" as const, detail: "no messages since last sleep" };
        case "cancelled":
          return { status: "failed" as const, error: `sleep cycle cancelled${failed}` };
        case "failed":
          return { status: "failed" as const, error: `essential sleep steps failed${failed}` };
        default:
          return { status: "failed" as const, error: `sleep cycle outcome could not be observed${failed}` };
      }
    });
    logInfo("boot", "registered system action sleep-cycle");
  }

  return "ran";
}
