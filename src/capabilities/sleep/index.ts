import { logAndSwallow } from "../../components/log-and-swallow.js";
/**
 * Sleep capability — nightly memory consolidation host (#1321).
 *
 * Scheduling is owned by the task store (a `sleep-cycle` system task in
 * tasks.json). This capability owns cycle *execution*: it admits one run,
 * allocates a Dreamy session, drives abmind's runSleepCycle asynchronously,
 * reports the result, resets memory on success, and always tears the session
 * down on every terminal path.
 *
 * startScheduled() / startManual() return a typed result promptly — they only
 * guard and start the async Promise chain. The scheduler, CronQueue, and
 * heartbeat are never blocked. There is no bedtime window, quiet-tick counter,
 * audit-today scheduling gate, hardware-sleep coupling, or bridge-lock force
 * flag (#1321). Cycle retry behavior is preserved.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getEnv } from "../../components/env-schema.js";
import type { Level } from "abmind";
import { abmind } from "../../utils/abmind-lazy.js";
import type { SleepRuntime } from "abmind";
import { logInfo, logWarn } from "../../components/logger.js";
import { writeSleepStatus } from "../../components/transport/bridge-lock-transport.js";
import { startSleepCard, type SleepCard } from "./sleep-card.js";
import type { CapabilityApi } from "../capability.js";

export interface SleepOpts {
  sleepAuditDir: string;
  memoryEnabled: boolean;
  memoryDir?: string;
  /** LLM runtime adapter — bridge wraps spin({ type: "D", ... }) (#1271). */
  runtime: SleepRuntime;
  /** Success-only path: reset per-chat context-window start markers. */
  onComplete: () => void;
  /** Always called once per cycle at the end — success, partial-failure, or throw.
   *  Tears down the night Dreamy session (#1287). */
  onCycleEnd?: () => void;
  /** Allocate a named Dreamy session upfront at sleep start (#1280). */
  allocateSleepSession?: (name: string) => void;
}

/** Typed, prompt result of admitting a sleep run. */
export type SleepStartResult =
  | { status: "accepted" }
  | { status: "already_running" }
  | { status: "unavailable"; reason: string };

export interface SleepProgress {
  percent: number;
  step: string;
}

export interface SleepHandle {
  /** True while a sleep cycle is running in-process. */
  readonly isActive: boolean;
  readonly progress: SleepProgress | null;
  /** Admit a scheduled run (from the `sleep-cycle` system task). Returns promptly. */
  startScheduled(): SleepStartResult;
  /** Admit an explicit manual run (`/sleep now` / `/sleep resume`). Returns promptly. */
  startManual(options: { fresh: boolean; resume: boolean }): SleepStartResult;
  /** Force-clear isActive if a run appears stuck (in-cycle guard, not a scheduler). */
  checkStale(): void;
}

const MAX_RETRIES = 3;
const RETRY_MS = 5 * 60 * 1000;
const STALE_MS = 30 * 60_000;

export function createSleepHandle(opts: SleepOpts): SleepHandle {
  let running = false;
  let attempts = 0;

  /** Resolve the configured sleep quality level from SLEEP_QUALITY env. */
  function scheduledLevel(): Level {
    const raw = getEnv().sleepQuality;
    if (!raw) return abmind()!.DEFAULT_LEVEL;
    try { return abmind()!.parseLevel(raw); }
    catch (err) {
      logWarn("sleep", `Invalid SLEEP_QUALITY='${raw}', using ${abmind()!.DEFAULT_LEVEL}: ${err instanceof Error ? err.message : String(err)}`);
      return abmind()!.DEFAULT_LEVEL;
    }
  }

  /** Build a one-line Dreamy report from the authoritative sleep lock (#1321 req 7). */
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

  /**
   * Start (or retry) the async sleep cycle. Never awaited by callers — runs to
   * terminal in the background. Guards `running` and Dreamy session lifecycle on
   * every outcome.
   */
  function runCycle(level: Level, fresh: boolean): void {
    // Allocate the Dreamy session upfront so it appears in /session for the full cycle (#1280).
    if (opts.allocateSleepSession) {
      const dateStr = new Date().toISOString().slice(0, 10);
      opts.allocateSleepSession(`Sleep ${dateStr}`);
    }
    running = true;
    writeSleepStatus("sleeping");
    logInfo("sleep", `😴 Sleep started in-process (attempt ${attempts}, model=dreamy)`);

    let sleepCard: SleepCard | null = null;
    abmind()!.runSleepCycle({
      runtime: opts.runtime,
      level,
      fresh,
      // #895: stepped card — created when the orchestrator commits to running steps,
      // ticked per step, completed once at cycle end (both success and failure paths).
      onCycleStart: () => { sleepCard = startSleepCard(); },
      onStep: (e) => sleepCard?.onStep(e),
    })
      .then(async (result: { ok: boolean; failCount: number }) => {
        running = false;
        sleepCard?.complete();
        logInfo("sleep", `😴 Sleep finished (ok=${result.ok}, failCount=${result.failCount}, attempt ${attempts})`);
        writeSleepStatus("awake");
        if (!result.ok) {
          retryOrGiveUp();
          return;
        }

        if (opts.memoryEnabled) opts.onComplete();

        const dreamReport = buildDreamReport();
        // #844: buffer silently — don't trigger model response
        const { bufferSystemEvent } = await import("../../components/system-event-buffer.js");
        bufferSystemEvent(dreamReport);
      })
      .catch((err: unknown) => {
        running = false;
        sleepCard?.complete();
        writeSleepStatus("awake");
        const msg = err instanceof Error ? err.message : String(err);
        logWarn("sleep", `😴 Sleep threw (attempt ${attempts}/${MAX_RETRIES}): ${msg}`);
        retryOrGiveUp();
      })
      .finally(() => {
        // #1287: tear down the night Dreamy session on EVERY cycle outcome. Retry
        // re-allocates a fresh Dreamy via allocateSleepSession.
        opts.onCycleEnd?.();
      });
  }

  /** Existing cycle retry behavior (#1321 preserves this; #1353 may revisit). */
  function retryOrGiveUp(): void {
    if (attempts < MAX_RETRIES) {
      logWarn("sleep", `😴 Sleep failed (attempt ${attempts}/${MAX_RETRIES}) — retry in 5min`);
      setTimeout(() => runCycle(scheduledLevel(), false), RETRY_MS);
    } else {
      logWarn("sleep", `😴 Sleep failures persist — exhausted ${MAX_RETRIES} attempts`);
    }
  }

  /** Start a fresh attempt, bumping the attempt counter. */
  function admit(level: Level, fresh: boolean): SleepStartResult {
    attempts++;
    runCycle(level, fresh);
    return { status: "accepted" };
  }

  return {
    get isActive() { return running; },
    get progress() { return null; },
    startScheduled(): SleepStartResult {
      if (running) return { status: "already_running" };
      return admit(scheduledLevel(), false);
    },
    startManual({ fresh, resume }): SleepStartResult {
      if (running) return { status: "already_running" };
      // /sleep now → fresh ultimate run; /sleep resume → fresh:false reuses durable state.
      void resume;
      const level = fresh ? ("ultimate" as Level) : scheduledLevel();
      return admit(level, fresh);
    },
    checkStale(): void {
      if (!running) return;
      try {
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const lockPath = join(opts.sleepAuditDir, `sleep_${dateStr}.lock`);
        if (!existsSync(lockPath)) { running = false; logWarn("sleep", "Sleep stuck — no lock file, force-clearing isActive"); return; }
        const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as { startedAt?: number; steps?: Record<string, { duration?: number }> };
        const stepTimes = Object.values(lock.steps ?? {}).map(s => (s as any).startedAt ?? (s as any).completedAt ?? 0).filter(Boolean);
        const lastActivity = Math.max(lock.startedAt ?? 0, ...stepTimes);
        if (lastActivity > 0 && Date.now() - lastActivity > STALE_MS) {
          running = false;
          logWarn("sleep", `Sleep stuck — no progress in 30min (last activity ${Math.round((Date.now() - lastActivity) / 60_000)}min ago), force-clearing isActive`);
        }
      } catch { /* lock file unreadable — leave running as-is, next tick retries */ }
    },
  };
}

/** Capability registration — called by discoverCapabilities(). */
export function register(_api: CapabilityApi): void {
  // Sleep registration is a no-op here — the actual SleepHandle is created
  // in phase-sleep.ts because it needs ctx deps that aren't available at
  // capability discovery time. This manifest exists so sleep appears in
  // discoverCapabilities() and can be disabled via DISABLED_CAPABILITIES=sleep.
}
