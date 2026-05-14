import { logAndSwallow } from "../../components/log-and-swallow.js";
import { getEnv } from "../../components/env-schema.js";
/**
 * Sleep capability — spawn nightly sleep cycle via tick system.
 * One path: BED_TIME + quiet ticks → Dreamy → quiet ticks → hardware sleep.
 * Parses PROGRESS:<pct>:<label> from stdout for visibility.
 */

import { execSync } from "node:child_process";
import { writeSleepStatus, readAndClearForceSleep } from "../../components/transport/bridge-lock-transport.js";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { hasSleepAuditToday, runSleepCycle, parseLevel, DEFAULT_LEVEL } from "abmind";
import type { SleepRuntime } from "abmind";
import { logInfo, logWarn, logDebug } from "../../components/logger.js";
import { readEnv, readEnvWithDefault } from "../../components/env.js";

export interface SleepOpts {
  sleepHour: number;
  sleepAuditDir: string;
  memoryEnabled: boolean;
  memoryDir?: string;
  /** LLM runtime adapter — bridge wraps its SubagentRuntime.complete("dreamy", ...). */
  runtime: SleepRuntime;
  onComplete: () => void;
  getLastMsgTs?: () => number;
  sendSystemMessage?: (prompt: string) => Promise<void>;
  killWakeInhibit?: () => void;
}

export interface SleepProgress {
  percent: number;
  step: string;
}

export interface SleepHandle {
  /** True while a sleep cycle is running in-process. */
  readonly isActive: boolean;
  readonly progress: SleepProgress | null;
  readonly awaitingHwSleep: boolean;
  spawn(): void;
  /** Called by tick system to check if hardware sleep should fire. */
  checkHwSleep(): void;
}

const MAX_RETRIES = 3;
const RETRY_MS = 5 * 60 * 1000;

export function createSleepHandle(opts: SleepOpts): SleepHandle {
  let running = false;
  let attempts = 0;
  let progress: SleepProgress | null = null;
  let _awaitingHwSleep = false;
  // Post-Dreamy hw-sleep quiet-tick tracking (internal to this closure — decoupled from
  // daily-cycle.quietTickCount which freezes once hasSleepAuditToday returns true).
  // Both reset when _awaitingHwSleep flips to true (see the onComplete handler below).
  let postSleepQuietTicks = 0;
  let lastMsgTsSeenByHwCheck = 0;

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
    } catch (err) { logAndSwallow("index", "op", err); }
    return dreamReport;
  }

  function spawnSleep(): void {
    const forceSleep = readAndClearForceSleep();
    const forced = forceSleep !== null;
    if (forced) {
      logInfo("sleep", `⚡ forceSleep=${forceSleep} — bypassing time-window + audit-today guards`);
    }

    if (!forced) {
      const hour = new Date().getHours();
      const WAKE_HOUR = parseInt(readEnvWithDefault("WAKE_TIME", "7", "wake hour").split(":")[0] ?? "7", 10);
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
    }
    if (running) return;
    attempts++;
    progress = null;
    running = true;
    writeSleepStatus("sleeping");
    logInfo("sleep", `😴 Sleep started in-process (attempt ${attempts}, model=dreamy)`);

    const level = (() => {
      const raw = getEnv().sleepQuality;
      if (!raw) return DEFAULT_LEVEL;
      try { return parseLevel(raw); }
      catch (err) { logWarn("sleep", `Invalid SLEEP_QUALITY='${raw}', using ${DEFAULT_LEVEL}: ${err instanceof Error ? err.message : String(err)}`); return DEFAULT_LEVEL; }
    })();

    runSleepCycle({ runtime: opts.runtime, level })
      .then((result) => {
        running = false;
        progress = null;
        logInfo("sleep", `😴 Sleep finished (ok=${result.ok}, failCount=${result.failCount}, attempt ${attempts})`);
        writeSleepStatus("awake");
        if (!result.ok) {
          if (attempts < MAX_RETRIES) {
            logWarn("sleep", `😴 Sleep had ${result.failCount} failures (attempt ${attempts}/${MAX_RETRIES}) — retry in 5min`);
            setTimeout(spawnSleep, RETRY_MS);
          } else {
            logWarn("sleep", `😴 Sleep failures persist — exhausted ${MAX_RETRIES} attempts`);
          }
          return;
        }

        if (opts.memoryEnabled) opts.onComplete();

        // Force-sleep runs are explicit test/verify triggers — skip hw-sleep even if env enabled.
        const hwEnabled = !forced && readEnv("HARDWARE_SLEEP_AFTER_DREAMY", "hardware sleep after Dreamy disabled") === "true";
        const quietTicks = Math.ceil(getEnv().bedQuietMin * 60 / parseInt(readEnvWithDefault("HEARTBEAT_INTERVAL_SEC", "300", "hb"), 10));
        const hbInterval = parseInt(readEnvWithDefault("HEARTBEAT_INTERVAL_SEC", "300", "heartbeat tick interval"), 10);
        const hwSleepMin = Math.round(quietTicks * hbInterval / 60);

        const dreamReport = buildDreamReport();
        const sleepNote = hwEnabled ? ` Hardware sleep in ~${hwSleepMin} minutes if no activity.` : "";

        if (opts.sendSystemMessage) {
          opts.sendSystemMessage(`${dreamReport}${sleepNote}`).catch(() => {});
        }

        if (hwEnabled) {
          _awaitingHwSleep = true;
          // Reset hw-check counters — prevents stale state from a prior cycle (crash, force-sleep
          // re-run) from poisoning this one, and avoids burning the first tick on a spurious
          // reset when the very first checkHwSleep() sees currentMsgTs > 0.
          postSleepQuietTicks = 0;
          lastMsgTsSeenByHwCheck = opts.getLastMsgTs?.() ?? 0;
          logInfo("sleep", `💤 Awaiting hardware sleep — ${quietTicks} quiet ticks (${hwSleepMin} min) required`);
        }
      })
      .catch((err) => {
        running = false;
        progress = null;
        writeSleepStatus("awake");
        const msg = err instanceof Error ? err.message : String(err);
        if (attempts < MAX_RETRIES) {
          logWarn("sleep", `😴 Sleep threw (attempt ${attempts}/${MAX_RETRIES}): ${msg} — retry in 5min`);
          setTimeout(spawnSleep, RETRY_MS);
        } else {
          logWarn("sleep", `😴 Sleep threw — exhausted ${MAX_RETRIES} attempts: ${msg}`);
        }
      });
  }

  function checkHwSleep(): void {
    if (!_awaitingHwSleep) return;

    // Sleep-window cutoff — give up if we've crossed out of the window. Next night retries.
    // Mirrors spawnSleep()'s window logic for consistency.
    const WAKE_HOUR = parseInt(readEnvWithDefault("WAKE_TIME", "7", "wake hour").split(":")[0] ?? "7", 10);
    const BED_HOUR = opts.sleepHour;
    const hour = new Date().getHours();
    const inSleepWindow = (BED_HOUR < WAKE_HOUR)
      ? (hour >= BED_HOUR && hour < WAKE_HOUR)    // normal: BED=00:30, WAKE=07:00 → sleep 00-06
      : (hour >= BED_HOUR || hour < WAKE_HOUR);   // overnight: BED=23:00, WAKE=07:00 → sleep 23-06
    if (!inSleepWindow) {
      logInfo("sleep", `⏰ Past sleep window (now ${hour}:00, window ${BED_HOUR}:00-${WAKE_HOUR}:00) — abandoning hw-sleep attempt`);
      _awaitingHwSleep = false;
      postSleepQuietTicks = 0;
      return;
    }

    // User messaged since last check — postpone and reset
    const currentMsgTs = opts.getLastMsgTs?.() ?? 0;
    if (currentMsgTs > lastMsgTsSeenByHwCheck) {
      lastMsgTsSeenByHwCheck = currentMsgTs;
      postSleepQuietTicks = 0;
      logInfo("sleep", "💤 Hardware sleep postponed — user messaged (will retry after quiet period)");
      return;
    }

    // Quiet tick — increment
    const requiredTicks = Math.ceil(getEnv().bedQuietMin * 60 / parseInt(process.env["HEARTBEAT_INTERVAL_SEC"] ?? "300", 10));
    postSleepQuietTicks++;
    if (postSleepQuietTicks < requiredTicks) return;

    // Threshold reached — sleep
    _awaitingHwSleep = false;
    postSleepQuietTicks = 0;
    // Kill any wake inhibitor from /wakeup before sleeping
    opts.killWakeInhibit?.();
    const sleepCmd = process.platform === "darwin" ? "pmset sleepnow" : "systemctl suspend";
    logInfo("sleep", `💤 Putting hardware to sleep (${sleepCmd})...`);
    writeSleepStatus("hw_sleep");
    try { execSync(sleepCmd, { timeout: 5000 }); }
    catch (err) {
      writeSleepStatus("awake"); // recover — don't leave "hw_sleep" if pmset failed
      logWarn("sleep", `💤 Hardware sleep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    get isActive() { return running; },
    get progress() { return progress; },
    get awaitingHwSleep() { return _awaitingHwSleep; },
    spawn: spawnSleep,
    checkHwSleep,
  };
}
