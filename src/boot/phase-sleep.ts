/**
 * phase-sleep — boot phase 10: create SleepHandle.
 *
 * Must run after phase-heartbeat (consumes ctx.sendSystemMessage).
 *
 * Populates ctx: sleepHandle.
 */

import { resetAllCtxStarts } from "./ctx-start.js";
import { logWarn } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import type { SleepRuntime } from "abmind";
import { readEnvWithDefault } from "../components/env.js";

export async function phaseSleep(ctx: BootCtx): Promise<PhaseResult> {
  const { memoryConfig, memory, sendSystemMessage, sessionManager } = ctx;
  if (!sendSystemMessage) { ctx.phaseHealth.set(phaseSleep.name, { status: "skipped", error: "no sendSystemMessage" }); logWarn("boot", `${phaseSleep.name}: skipping — heartbeat not available`); return "skipped"; }

  const { createSleepHandle } = await import("../capabilities/sleep/index.js");
  const { killWakeInhibit } = await import("../components/commands/index.js");
  const SLEEP_HOUR = parseInt(readEnvWithDefault("BED_TIME", "2", "bedtime hour").split(":")[0] ?? "2", 10);

  // #1271: SleepRuntime adapter — wraps spin({ type: "D", ... }) for the in-process
  // orchestrator. ONE nightSessionId is held for the whole cycle (set from step 1's
  // result, reused for steps 2+) so D's persistent transport keeps a shared Dreamy
  // conversation. D profile is external-terminate, so the session stays alive until
  // the cycle completes (and is ended in onComplete).
  let nightSessionId: string | undefined;
  const { getEnv } = await import("../components/env-schema.js");
  const runtime: SleepRuntime = {
    async complete(prompt: string): Promise<string> {
      const { result, sessionId } = await sessionManager.spin({
        type: "D",
        prompt,
        sessionId: nightSessionId, // undefined on step 1 → transient alloc; reused on steps 2+
        timeoutMs: getEnv().modelApiTimeoutMs * 3,
        await: true,
      });
      // First successful call: capture the nightSessionId for cross-step reuse.
      if (sessionId && !nightSessionId) nightSessionId = sessionId;
      return result ?? "";
    },
  };

  ctx.sleepHandle = createSleepHandle({
    sleepHour: SLEEP_HOUR,
    sleepAuditDir: ctx.sleepAuditDir,
    memoryEnabled: memoryConfig.memoryEnabled,
    runtime,
    onComplete: () => {
      // End the D session at cycle completion so it doesn't accumulate across nights.
      // Fresh nightSessionId for the next sleep cycle.
      if (nightSessionId) {
        const s = sessionManager.getSessionById(nightSessionId);
        if (s) s.status = "ended";
        nightSessionId = undefined;
      }
      resetAllCtxStarts(memoryConfig.memoryDir);
    },
    getLastMsgTs: () => memory?.getLastMessageTimestamp(true) ?? 0,
    sendSystemMessage,
    killWakeInhibit,
    allocateSleepSession: (name: string) => {
      // Allocate the D session eagerly so it's visible in /session for the full cycle (#1280).
      const s = sessionManager.allocateDreamySession(name);
      nightSessionId = s.id;
    },
  });
  return "ran";
}
