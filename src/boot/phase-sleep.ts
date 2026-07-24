import { resetAllCtxStarts } from "./ctx-start.js";
import { logInfo, logWarn } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { getSystemTaskRegistry } from "../components/tasks/system-task-registry.js";

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
      sessionManager.allocateDreamySession(name);
    },
    sessionManager: {
      spin: async (opts: { type: string; prompt: string; sessionId?: string; timeoutMs: number; await: boolean }) => {
        return sessionManager.spin({ type: opts.type as any, prompt: opts.prompt, sessionId: opts.sessionId, timeoutMs: opts.timeoutMs, await: true });
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
    registry.register("sleep-cycle", () => {
      const result = handle.startScheduled();
      if (result.status === "already_running") {
        return { status: "noop" as const, detail: "already running" };
      }
      if (result.status === "unavailable") {
        return { status: "failed" as const, error: result.reason };
      }
      return { status: "accepted" as const, detail: "sleep cycle started" };
    });
    logInfo("boot", "registered system action sleep-cycle");
  }

  return "ran";
}
