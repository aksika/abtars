/**
 * Sleep capability — spawn nightly sleep cycle with retry logic.
 */

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasSleepAuditToday } from "../../components/sleep-trigger.js";
import { logInfo, logWarn, logDebug } from "../../components/logger.js";

export interface SleepOpts {
  sleepHour: number;
  sleepAuditDir: string;
  memoryEnabled: boolean;
  onComplete: () => void;
}

export interface SleepHandle {
  readonly child: import("node:child_process").ChildProcess | null;
  spawn(): void;
}

const MAX_RETRIES = 3;
const RETRY_MS = 5 * 60 * 1000;

export function createSleepHandle(opts: SleepOpts): SleepHandle {
  let child: import("node:child_process").ChildProcess | null = null;
  let attempts = 0;

  function spawnSleep(): void {
    if (new Date().getHours() < opts.sleepHour) {
      logDebug("sleep", `😴 Before SLEEP_TIME (${opts.sleepHour}:00) — skip`);
      return;
    }
    if (hasSleepAuditToday(opts.sleepAuditDir)) {
      logDebug("sleep", "😴 Sleep already done today — skip");
      return;
    }
    if (child && !child.killed) return;
    attempts++;
    try {
      const sleepScript = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "agentbridge-sleep.js");
      const proc = spawn(process.execPath, [sleepScript], { stdio: "ignore" });
      child = proc;
      proc.on("exit", (code) => {
        child = null;
        if (code === 0) {
          logInfo("sleep", `😴 Sleep finished successfully (attempt ${attempts})`);
          if (opts.memoryEnabled) opts.onComplete();
        } else if (attempts < MAX_RETRIES) {
          logWarn("sleep", `😴 Sleep failed (code=${code}, attempt ${attempts}/${MAX_RETRIES}) — retry in 5min`);
          setTimeout(spawnSleep, RETRY_MS);
        } else {
          logWarn("sleep", `😴 Sleep failed (code=${code}) — exhausted ${MAX_RETRIES} attempts`);
        }
      });
      logInfo("sleep", `😴 Sleep spawned (pid=${proc.pid}, attempt ${attempts})`);
    } catch (err) {
      logWarn("sleep", `😴 Sleep spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempts < MAX_RETRIES) setTimeout(spawnSleep, RETRY_MS);
    }
  }

  return {
    get child() { return child; },
    spawn: spawnSleep,
  };
}
