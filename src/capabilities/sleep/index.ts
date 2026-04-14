/**
 * Sleep capability — spawn nightly sleep cycle via tick system.
 * One path: BED_TIME + quiet ticks → Dreamy → quiet ticks → hardware sleep.
 * Parses PROGRESS:<pct>:<label> from stdout for visibility.
 */

import { spawn, execSync } from "node:child_process";
import { writeSleepStatus } from "../../components/transport/bridge-lock-transport.js";
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
  getLastMsgTs?: () => number;
  sendSystemMessage?: (prompt: string) => Promise<void>;
}

export interface SleepProgress {
  percent: number;
  step: string;
}

export interface SleepHandle {
  readonly child: import("node:child_process").ChildProcess | null;
  readonly progress: SleepProgress | null;
  readonly awaitingHwSleep: boolean;
  spawn(): void;
  /** Called by tick system to check if hardware sleep should fire. */
  checkHwSleep(quietTicks: number, requiredTicks: number): void;
}

const MAX_RETRIES = 3;
const RETRY_MS = 5 * 60 * 1000;

export function createSleepHandle(opts: SleepOpts): SleepHandle {
  let child: import("node:child_process").ChildProcess | null = null;
  let attempts = 0;
  let progress: SleepProgress | null = null;
  let _awaitingHwSleep = false;
  let hwSleepAnnouncedAt = 0;

  function buildDreamReport(): string {
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
    return dreamReport;
  }

  function spawnSleep(): void {
    const hour = new Date().getHours();
    const WAKE_HOUR = parseInt(process.env["WAKE_TIME"]?.split(":")[0] ?? "7", 10);
    if (opts.sleepHour <= WAKE_HOUR) {
      if (hour < opts.sleepHour || hour >= WAKE_HOUR) {
        logDebug("sleep", `😴 Outside sleep window (${opts.sleepHour}:00-${WAKE_HOUR}:00) — skip`);
        return;
      }
    } else {
      if (hour < opts.sleepHour && hour >= WAKE_HOUR) {
        logDebug("sleep", `😴 Outside sleep window (${opts.sleepHour}:00-${WAKE_HOUR}:00) — skip`);
        return;
      }
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

      let buf = "";
      proc.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const match = line.match(/^PROGRESS:(\d+):(.+)$/);
          if (match) progress = { percent: parseInt(match[1]!, 10), step: match[2]! };
        }
      });

      proc.on("exit", (code) => {
        child = null;
        progress = null;
        if (code === 0) {
          logInfo("sleep", `😴 Sleep finished successfully (attempt ${attempts})`);
          writeSleepStatus("awake");
          if (opts.memoryEnabled) opts.onComplete();

          // Send dream report + announce hw sleep timing
          const hwEnabled = process.env["HARDWARE_SLEEP_AFTER_DREAMY"] === "true";
          const quietTicks = parseInt(process.env["BED_QUIET_TICKS"] ?? "2", 10);
          const hbInterval = parseInt(process.env["HEARTBEAT_INTERVAL_SEC"] ?? "300", 10);
          const hwSleepMin = Math.round(quietTicks * hbInterval / 60);

          const dreamReport = buildDreamReport();
          const sleepNote = hwEnabled ? ` Hardware sleep in ~${hwSleepMin} minutes if no activity.` : "";

          if (opts.sendSystemMessage) {
            opts.sendSystemMessage(`${dreamReport}${sleepNote} Send the user a brief, friendly dream report — highlight what was done and flag any issues.`).catch(() => {});
          }

          if (hwEnabled) {
            _awaitingHwSleep = true;
            hwSleepAnnouncedAt = Date.now();
            logInfo("sleep", `💤 Awaiting hardware sleep — ${quietTicks} quiet ticks (${hwSleepMin} min) required`);
          }
        } else if (attempts < MAX_RETRIES) {
          logWarn("sleep", `😴 Sleep failed (code=${code}, attempt ${attempts}/${MAX_RETRIES}) — retry in 5min`);
          setTimeout(spawnSleep, RETRY_MS);
        } else {
          logWarn("sleep", `😴 Sleep failed (code=${code}) — exhausted ${MAX_RETRIES} attempts`);
          writeSleepStatus("awake");
        }
      });
      logInfo("sleep", `😴 Sleep spawned (pid=${proc.pid}, attempt ${attempts}, model=dreamy)`);
      writeSleepStatus("sleeping");
    } catch (err) {
      logWarn("sleep", `😴 Sleep spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempts < MAX_RETRIES) setTimeout(spawnSleep, RETRY_MS);
    }
  }

  function checkHwSleep(quietTicks: number, requiredTicks: number): void {
    if (!_awaitingHwSleep) return;

    // User messaged after announcement — cancel
    const currentMsgTs = opts.getLastMsgTs?.() ?? 0;
    if (currentMsgTs > hwSleepAnnouncedAt) {
      logInfo("sleep", "💤 Hardware sleep cancelled — user messaged after announcement");
      _awaitingHwSleep = false;
      return;
    }

    if (quietTicks < requiredTicks) return;

    _awaitingHwSleep = false;
    const sleepCmd = process.platform === "darwin" ? "pmset sleepnow" : "systemctl suspend";
    logInfo("sleep", `💤 Putting hardware to sleep (${sleepCmd})...`);
    writeSleepStatus("hw_sleep");
    try { execSync(sleepCmd, { timeout: 5000 }); }
    catch (err) { logWarn("sleep", `💤 Hardware sleep failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  return {
    get child() { return child; },
    get progress() { return progress; },
    get awaitingHwSleep() { return _awaitingHwSleep; },
    spawn: spawnSleep,
    checkHwSleep,
  };
}
