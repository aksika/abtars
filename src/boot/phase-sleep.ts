/**
 * phase-sleep — boot phase 10: create SleepHandle.
 *
 * Must run after phase-heartbeat (consumes ctx.sendSystemMessage).
 *
 * Populates ctx: sleepHandle.
 */

import { resetAllCtxStarts } from "./ctx-start.js";
import type { BootCtx } from "./context.js";

export async function phaseSleep(ctx: BootCtx): Promise<void> {
  const { memoryConfig, memory, sendSystemMessage } = ctx;
  if (!sendSystemMessage) throw new Error("phase-sleep: ctx.sendSystemMessage not set (phase-heartbeat must run first)");

  const { createSleepHandle } = await import("../capabilities/sleep/index.js");
  const { killWakeInhibit } = await import("../components/command-handlers.js");
  const SLEEP_HOUR = parseInt(process.env["BED_TIME"]?.split(":")[0] ?? "2", 10);

  ctx.sleepHandle = createSleepHandle({
    sleepHour: SLEEP_HOUR,
    sleepAuditDir: ctx.sleepAuditDir,
    memoryEnabled: memoryConfig.memoryEnabled,
    onComplete: () => resetAllCtxStarts(memoryConfig.memoryDir),
    getLastMsgTs: () => memory?.getLastMessageTimestamp(true) ?? 0,
    sendSystemMessage,
    killWakeInhibit,
  });
}
