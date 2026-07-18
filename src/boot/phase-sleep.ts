/**
 * phase-sleep — boot phase: create SleepHandle + register the `sleep-cycle`
 * system action (#1321, thin-host-supervisor migration #1353).
 *
 * Must run after phase-heartbeat (consumes ctx.sendSystemMessage) and phase-memory.
 *
 * Scheduling is owned by the `sleep-cycle` task entry in tasks.json; this phase
 * owns cycle *execution*. The system handler registered here is dispatched
 * in-process by CronQueue.runSystem — no shell, no PATH lookup, no force flag.
 *
 * #1429 — Prerequisite validation with deterministic precedence:
 *   1. memory disabled → memory_disabled
 *   2. abmind module not loaded → abmind_not_loaded
 *   3. no heartbeat → heartbeat_unavailable
 *   All three record ctx.sleepUnavailable and register a failing scheduled handler.
 *
 * Populates ctx: sleepHandle.
 */

import { resetAllCtxStarts } from "./ctx-start.js";
import { logInfo, logWarn } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import type { SleepRuntime, SleepCompletionRequest } from "abmind";
import { getSystemTaskRegistry } from "../components/tasks/system-task-registry.js";

/** #1429 — Register a handler that fails with the given reason so the scheduled
 *  task follows ordinary failure/auto-pause policy. Idempotent. */
function registerUnavailableHandler(reason: string): void {
  const registry = getSystemTaskRegistry();
  if (!registry.has("sleep-cycle")) {
    registry.register("sleep-cycle", () => ({ status: "failed", error: reason }));
  }
}

export async function phaseSleep(ctx: BootCtx): Promise<PhaseResult> {
  const { memoryConfig, sendSystemMessage, sessionManager } = ctx;
  const { unavailable, createSleepHandle } = await import("../capabilities/sleep/index.js");
  type SleepApi = import("../capabilities/sleep/index.js").SleepApi;

  // Reset for isolated phase tests and restart correctness.
  ctx.sleepHandle = null;
  ctx.sleepUnavailable = null;

  // Precedence 1: memory disabled.
  if (!memoryConfig.memoryEnabled) {
    ctx.sleepUnavailable = unavailable("memory_disabled");
    ctx.phaseHealth.set(phaseSleep.name, { status: "skipped", error: "memory disabled" });
    logWarn("boot", `${phaseSleep.name}: skipping — memory disabled`);
    registerUnavailableHandler(ctx.sleepUnavailable.reason);
    return "skipped";
  }

  // Precedence 2: abmind module not loaded.
  if (!ctx.abmindModule) {
    ctx.sleepUnavailable = unavailable("abmind_not_loaded");
    ctx.phaseHealth.set(phaseSleep.name, { status: "skipped", error: "abmind not loaded" });
    logWarn("boot", `${phaseSleep.name}: skipping — abmind not loaded`);
    registerUnavailableHandler(ctx.sleepUnavailable.reason);
    return "skipped";
  }

  // Precedence 3: no heartbeat/system-message callback.
  if (!sendSystemMessage) {
    ctx.sleepUnavailable = unavailable("heartbeat_unavailable");
    ctx.phaseHealth.set(phaseSleep.name, { status: "skipped", error: "no sendSystemMessage" });
    logWarn("boot", `${phaseSleep.name}: skipping — heartbeat not available`);
    registerUnavailableHandler(ctx.sleepUnavailable.reason);
    return "skipped";
  }

  // #1271/#1353: SleepRuntime adapter — wraps spin({ type: "D", ... }) for the
  // host-neutral orchestrator. ONE nightSessionId is held for the whole cycle
  // (set from step 1's result, reused for steps 2+) so D's persistent transport
  // keeps a shared Dreamy conversation. D profile is external-terminate, so the
  // session stays alive across steps; it is ended in onCycleEnd, which fires on
  // every cycle outcome (#1287). This adapter does not implement its own
  // retry; a Spin/transport failure rejects and abmind applies its own
  // essential-step stop/suspend policy. request.signal (abmind's internal
  // cancellation/timeout) is not yet threaded into Spin's transport layer —
  // that would require new Spin API surface out of #1353's scope; abmind's
  // own timeout still bounds each call from the abmind side.
  let nightSessionId: string | undefined;
  const { getEnv } = await import("../components/env-schema.js");
  const runtime: SleepRuntime = {
    async complete(request: SleepCompletionRequest): Promise<string> {
      const { result, sessionId } = await sessionManager.spin({
        type: "D",
        prompt: request.prompt,
        sessionId: nightSessionId,
        timeoutMs: getEnv().modelApiTimeoutMs * 3,
        await: true,
      });
      if (sessionId && !nightSessionId) nightSessionId = sessionId;
      return result ?? "";
    },
  };

  const handle = createSleepHandle({
    api: ctx.abmindModule as SleepApi,
    memoryEnabled: memoryConfig.memoryEnabled,
    runtime,
    onComplete: () => {
      resetAllCtxStarts(memoryConfig.memoryDir);
    },
    onCycleEnd: () => {
      if (nightSessionId) {
        const s = sessionManager.getSessionById(nightSessionId);
        if (s) s.status = "ended";
        nightSessionId = undefined;
      }
    },
    allocateSleepSession: (name: string) => {
      const s = sessionManager.allocateDreamySession(name);
      nightSessionId = s.id;
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
