/**
 * Sleep capability — spawn nightly sleep cycle with retry logic.
 * Parses PROGRESS:<pct>:<label> from stdout for visibility.
 */

import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasSleepAuditToday } from "./sleep-trigger.js";
import { logInfo, logWarn, logDebug } from "../../components/logger.js";

export interface SleepOpts {
  sleepHour: number;
  sleepAuditDir: string;
  memoryEnabled: boolean;
  onComplete: () => void;
  /** Returns latest user message timestamp. Used to check if user messaged during sleep. */
  getLastMsgTs?: () => number;
  /** Send a system message to the agent (for sleep announcement). */
  sendSystemMessage?: (prompt: string) => Promise<void>;
}

export interface SleepProgress {
  percent: number;
  step: string;
}

export interface SleepHandle {
  readonly child: import("node:child_process").ChildProcess | null;
  readonly progress: SleepProgress | null;
  spawn(): void;
}

const MAX_RETRIES = 3;
const RETRY_MS = 5 * 60 * 1000;

export function createSleepHandle(opts: SleepOpts): SleepHandle {
  let child: import("node:child_process").ChildProcess | null = null;
  let attempts = 0;
  let progress: SleepProgress | null = null;
  let msgTsAtSpawn = 0;

  function spawnSleep(): void {
    msgTsAtSpawn = opts.getLastMsgTs?.() ?? 0;
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
    progress = null;
    try {
      const sleepScript = join(dirname(fileURLToPath(import.meta.url)), "agentbridge-sleep.js");
      const proc = spawn(process.execPath, [sleepScript], { stdio: ["ignore", "pipe", "ignore"] });
      child = proc;

      // Parse PROGRESS lines from stdout
      let buf = "";
      proc.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const match = line.match(/^PROGRESS:(\d+):(.+)$/);
          if (match) {
            progress = { percent: parseInt(match[1]!, 10), step: match[2]! };
          }
        }
      });

      proc.on("exit", (code) => {
        child = null;
        progress = null;
        if (code === 0) {
          logInfo("sleep", `😴 Sleep finished successfully (attempt ${attempts})`);
          if (opts.memoryEnabled) opts.onComplete();
          // Put Mac to sleep after successful sleep cycle — only if user stayed quiet
          if (process.env["MAC_SLEEP_AFTER_DREAMY"] === "true") {
            const currentMsgTs = opts.getLastMsgTs?.() ?? 0;
            if (currentMsgTs > msgTsAtSpawn) {
              logInfo("sleep", "💤 Mac sleep skipped — user messaged during sleep cycle");
            } else {
              logInfo("sleep", "💤 Announcing sleep — will sleep after 1 tick if user stays quiet");
              const announceMsgTs = opts.getLastMsgTs?.() ?? 0;
              if (opts.sendSystemMessage) {
                opts.sendSystemMessage("Dreamy finished nightly maintenance. Announce to the user that the system is going to sleep in ~5 minutes. If they need anything, now is the time. Keep it brief and friendly.").catch(() => {});
              }
              // Wait one heartbeat tick (5 min), then check if user interrupted
              setTimeout(() => {
                const postAnnounceMsgTs = opts.getLastMsgTs?.() ?? 0;
                if (postAnnounceMsgTs > announceMsgTs) {
                  logInfo("sleep", "💤 Mac sleep cancelled — user messaged after announcement");
                  return;
                }
                logInfo("sleep", "💤 Putting Mac to sleep...");
                try { execSync("pmset sleepnow", { timeout: 5000 }); }
                catch (err) { logWarn("sleep", `💤 Mac sleep failed: ${err instanceof Error ? err.message : String(err)}`); }
              }, 5 * 60 * 1000);
            }
          }
        } else if (attempts < MAX_RETRIES) {
          logWarn("sleep", `😴 Sleep failed (code=${code}, attempt ${attempts}/${MAX_RETRIES}) — retry in 5min`);
          setTimeout(spawnSleep, RETRY_MS);
        } else {
          logWarn("sleep", `😴 Sleep failed (code=${code}) — exhausted ${MAX_RETRIES} attempts`);
        }
      });
      logInfo("sleep", `😴 Sleep spawned (pid=${proc.pid}, attempt ${attempts}, model=${process.env["AGENT_SLEEP_MODEL"] ?? "auto"})`);
    } catch (err) {
      logWarn("sleep", `😴 Sleep spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempts < MAX_RETRIES) setTimeout(spawnSleep, RETRY_MS);
    }
  }

  return {
    get child() { return child; },
    get progress() { return progress; },
    spawn: spawnSleep,
  };
}
