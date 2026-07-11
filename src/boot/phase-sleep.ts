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
 * Populates ctx: sleepHandle.
 */

import { resetAllCtxStarts } from "./ctx-start.js";
import { logInfo, logWarn } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import type { SleepRuntime, SleepCompletionRequest } from "abmind";
import { getSystemTaskRegistry } from "../components/tasks/system-task-registry.js";

export async function phaseSleep(ctx: BootCtx): Promise<PhaseResult> {
  const { memoryConfig, sendSystemMessage, sessionManager } = ctx;

  const registry = getSystemTaskRegistry();

  // Unavailable path: no sendSystemMessage means heartbeat isn't up. Register a
  // handler that fails visibly so the scheduled task follows ordinary
  // failure/auto-pause policy rather than becoming an unknown action (#1321).
  if (!sendSystemMessage) {
    ctx.phaseHealth.set(phaseSleep.name, { status: "skipped", error: "no sendSystemMessage" });
    logWarn("boot", `${phaseSleep.name}: skipping — heartbeat not available`);
    if (!registry.has("sleep-cycle")) {
      registry.register("sleep-cycle", () => ({ status: "failed", error: "sleep unavailable: heartbeat/memory not initialized" }));
    }
    return "skipped";
  }

  const { createSleepHandle } = await import("../capabilities/sleep/index.js");

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
        sessionId: nightSessionId, // undefined on step 1 → transient alloc; reused on steps 2+
        timeoutMs: getEnv().modelApiTimeoutMs * 3,
        await: true,
      });
      // First successful call: capture the nightSessionId for cross-step reuse.
      if (sessionId && !nightSessionId) nightSessionId = sessionId;
      return result ?? "";
    },
  };

  const handle = createSleepHandle({
    memoryEnabled: memoryConfig.memoryEnabled,
    runtime,
    onComplete: () => {
      // Success + memory only: reset per-chat context-window start markers.
      resetAllCtxStarts(memoryConfig.memoryDir);
    },
    onCycleEnd: () => {
      // #1287: runs on EVERY cycle outcome (success, partial-failure, throw). End the
      // night Dreamy session so it doesn't accumulate — pruneEndedSessions reaps ended
      // sessions hourly. Fresh nightSessionId for the next cycle / retry.
      if (nightSessionId) {
        const s = sessionManager.getSessionById(nightSessionId);
        if (s) s.status = "ended";
        nightSessionId = undefined;
      }
    },
    allocateSleepSession: (name: string) => {
      // Allocate the D session eagerly so it's visible in /session for the full cycle (#1280).
      const s = sessionManager.allocateDreamySession(name);
      nightSessionId = s.id;
    },
  });
  ctx.sleepHandle = handle;

  // Register the allowlisted in-process sleep-cycle action. Dispatch returns
  // promptly; the long-running cycle continues asynchronously (#1321 req 6/8).
  if (!registry.has("sleep-cycle")) {
    registry.register("sleep-cycle", () => {
      const result = handle.startScheduled();
      if (result.status === "already_running") {
        // Idempotent successful no-op — does not create another Dreamy session/card.
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
