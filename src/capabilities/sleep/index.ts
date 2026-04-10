/**
 * Sleep capability — spawn nightly sleep cycle with retry logic.
 * Parses PROGRESS:<pct>:<label> from stdout for visibility.
 */

import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasSleepAuditToday } from "./sleep-trigger.js";
import { logInfo, logWarn, logDebug } from "../../components/logger.js";

export interface SleepOpts {
  sleepHour: number;
  sleepAuditDir: string;
  memoryEnabled: boolean;
  memoryDir?: string;
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
          // Put hardware to sleep after successful sleep cycle — only if user stayed quiet
          if (process.env["HARDWARE_SLEEP_AFTER_DREAMY"] === "true" || process.env["MAC_SLEEP_AFTER_DREAMY"] === "true") {
            const currentMsgTs = opts.getLastMsgTs?.() ?? 0;
            if (currentMsgTs > msgTsAtSpawn) {
              logInfo("sleep", "💤 Hardware sleep skipped — user messaged during sleep cycle");
            } else {
              logInfo("sleep", "💤 Announcing sleep — will sleep after 1 tick if user stays quiet");
              const announceMsgTs = opts.getLastMsgTs?.() ?? 0;
              if (opts.sendSystemMessage) {
                // Build dream report from lock file
                let dreamReport = "Dreamy finished nightly maintenance.";
                try {
                  const sleepDir = join(opts.memoryDir ?? "", "sleep");
                  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
                  const lockPath = join(sleepDir, `sleep_${dateStr}.lock`);
                  if (existsSync(lockPath)) {
                    const lockData = JSON.parse(readFileSync(lockPath, "utf-8")) as { steps: Record<string, { status: string }>; llmCalls?: number };
                    const ok = Object.entries(lockData.steps).filter(([, s]) => s.status === "ok").map(([k]) => k);
                    const skipped = Object.entries(lockData.steps).filter(([, s]) => s.status === "skipped").map(([k]) => k);
                    const failed = Object.entries(lockData.steps).filter(([, s]) => s.status === "failed" || s.status === "timeout").map(([k]) => k);
                    dreamReport = `Dreamy finished nightly maintenance (${lockData.llmCalls ?? "?"} LLM calls). Completed: ${ok.join(", ") || "none"}.`;
                    if (skipped.length > 0) dreamReport += ` Skipped: ${skipped.join(", ")}.`;
                    if (failed.length > 0) dreamReport += ` ⚠️ FAILED: ${failed.join(", ")}. Please review.`;
                  }
                } catch { /* lock file not readable */ }
                const hwSleep = (process.env["HARDWARE_SLEEP_AFTER_DREAMY"] === "true" || process.env["MAC_SLEEP_AFTER_DREAMY"] === "true");
                const sleepNote = hwSleep ? " The system is going to sleep in ~5 minutes. If the user needs anything, now is the time." : "";
                opts.sendSystemMessage(`${dreamReport}${sleepNote} Send the user a brief, friendly dream report — highlight what was done and flag any issues.`).catch(() => {});
              }
              // Wait one heartbeat tick (5 min), then check if user interrupted
              setTimeout(() => {
                const postAnnounceMsgTs = opts.getLastMsgTs?.() ?? 0;
                if (postAnnounceMsgTs > announceMsgTs) {
                  logInfo("sleep", "💤 Hardware sleep cancelled — user messaged after announcement");
                  return;
                }
                const sleepCmd = process.platform === "darwin" ? "pmset sleepnow" : "systemctl suspend";
                logInfo("sleep", `💤 Putting hardware to sleep (${sleepCmd})...`);
                try { execSync(sleepCmd, { timeout: 5000 }); }
                catch (err) { logWarn("sleep", `💤 Hardware sleep failed: ${err instanceof Error ? err.message : String(err)}`); }
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
