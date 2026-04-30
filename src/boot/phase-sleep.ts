/**
 * phase-sleep — boot phase 10: create SleepHandle.
 *
 * Must run after phase-heartbeat (consumes ctx.sendSystemMessage).
 *
 * Populates ctx: sleepHandle.
 */

import { resetAllCtxStarts } from "./ctx-start.js";
import { logWarn } from "../components/logger.js";
import type { BootCtx } from "./context.js";
import { SubagentRuntime } from "../components/subagent-runtime.js";
import type { SleepRuntime } from "abmind";
import { readEnvWithDefault } from "../components/env.js";

export async function phaseSleep(ctx: BootCtx): Promise<void> {
  const { memoryConfig, memory, sendSystemMessage } = ctx;
  if (!sendSystemMessage) { ctx.phaseHealth.set(phaseSleep.name, { status: "skipped", error: "no sendSystemMessage" }); logWarn("boot", `${phaseSleep.name}: skipping — heartbeat not available`); return; }

  const { createSleepHandle } = await import("../capabilities/sleep/index.js");
  const { killWakeInhibit } = await import("../components/command-handlers.js");
  const SLEEP_HOUR = parseInt(readEnvWithDefault("BED_TIME", "2", "bedtime hour").split(":")[0] ?? "2", 10);

  // SleepRuntime adapter — wraps SubagentRuntime.complete("dreamy", ...) for the in-process orchestrator.
  // Lazy SubagentRuntime construction — only materialized on first sleep invocation.
  let subagent: SubagentRuntime | null = null;
  const runtime: SleepRuntime = {
    async complete(prompt: string): Promise<string> {
      if (!subagent) subagent = new SubagentRuntime();
      return subagent.complete("dreamy", prompt, { session: "reuse" });
    },
  };

  ctx.sleepHandle = createSleepHandle({
    sleepHour: SLEEP_HOUR,
    sleepAuditDir: ctx.sleepAuditDir,
    memoryEnabled: memoryConfig.memoryEnabled,
    runtime,
    onComplete: () => resetAllCtxStarts(memoryConfig.memoryDir),
    getLastMsgTs: () => memory?.getLastMessageTimestamp(true) ?? 0,
    sendSystemMessage,
    killWakeInhibit,
  });
}
