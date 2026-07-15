/**
 * Sleep capability — thin host supervisor over abmind's host-neutral sleep
 * contract (#1353, superseding the #1321 cycle-execution shell).
 *
 * Scheduling is owned by the task store (a `sleep-cycle` system task in
 * tasks.json). This supervisor owns only: admission, allocating one Dreamy
 * session, translating abmind's neutral SleepEvent stream to one sleep-card,
 * using the returned SleepRunResult for reset/reporting, and always tearing
 * the Dreamy session down on every terminal path.
 *
 * It does NOT: inspect sleep_*.lock, reconstruct completed/skipped/failed
 * lists from raw state, run its own MAX_RETRIES/setTimeout cycle-retry loop,
 * decide watermark success, or know the sleep-step manifest well enough to
 * execute/resume individual steps. Durable per-step recovery, resume, and
 * catch-up all belong to abmind; a bounded scheduler-level retry after a
 * terminal run is an abtars task policy (auto-pause via CronQueue), not an
 * in-memory timer here.
 */

import type { Level, SleepRunResult, SleepEvent } from "abmind";
import type { SleepRuntime, SleepCompletionRequest } from "abmind";
import { getEnv } from "../../components/env-schema.js";
import { logInfo, logWarn } from "../../components/logger.js";
import { writeSleepStatus } from "../../components/transport/bridge-lock-transport.js";
import { startSleepCard, type SleepCard } from "./sleep-card.js";
import type { CapabilityApi } from "../capability.js";

/** #1429 — Narrow abmind surface injected at construction. No runtime
 *  re-discovery. */
export type SleepApi = Pick<
  typeof import("abmind"),
  "DEFAULT_LEVEL" | "parseLevel" | "runSleepCycle"
>;

export type SleepUnavailableCode =
  | "memory_disabled"
  | "abmind_not_loaded"
  | "heartbeat_unavailable"
  | "sleep_not_initialized";

export interface SleepUnavailable {
  status: "unavailable";
  code: SleepUnavailableCode;
  reason: string;
}

/** Host-owned model runtime factory. abtars wraps its Spin/transport policy;
 *  a rejection here is final for this attempt — abmind does not retry it. */
export type SleepRuntimeFactory = (request: SleepCompletionRequest) => Promise<string>;

export interface SleepOpts {
  /** #1429 — Injected narrow abmind API. Validated once at construction. */
  api: SleepApi;
  memoryEnabled: boolean;
  /** Host-owned model runtime — wraps spin({ type: "D", ... }) (#1271, #1353). */
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
  | SleepUnavailable;

/** #1429 — Fixed unavailable reasons keyed by code. */
export function unavailable(code: SleepUnavailableCode): SleepUnavailable {
  const reasons: Record<SleepUnavailableCode, string> = {
    memory_disabled: "memory is disabled",
    abmind_not_loaded: "abmind did not initialize during boot",
    heartbeat_unavailable: "heartbeat is unavailable",
    sleep_not_initialized: "sleep did not initialize during boot",
  };
  return { status: "unavailable", code, reason: reasons[code] };
}

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
}

export function createSleepHandle(opts: SleepOpts): SleepHandle {
  const { api } = opts;
  let running = false;
  let progress: SleepProgress | null = null;
  const shutdownController = new AbortController();

  function scheduledLevel(): Level {
    const raw = getEnv().sleepQuality;
    if (!raw) return api.DEFAULT_LEVEL;
    try { return api.parseLevel(raw); }
    catch (err) {
      logWarn("sleep", `Invalid SLEEP_QUALITY='${raw}', using ${api.DEFAULT_LEVEL}: ${err instanceof Error ? err.message : String(err)}`);
      return api.DEFAULT_LEVEL;
    }
  }

  function runCycle(level: Level, fresh: boolean, mode: "scheduled" | "manual" | "resume"): void {
    if (opts.allocateSleepSession) {
      const dateStr = new Date().toISOString().slice(0, 10);
      opts.allocateSleepSession(`Sleep ${dateStr}`);
    }
    running = true;
    progress = { percent: 0, step: "starting" };
    writeSleepStatus("sleeping");
    logInfo("sleep", `😴 Sleep started in-process (mode=${mode}, model=dreamy)`);

    let sleepCard: SleepCard | null = null;
    let totalSteps = 0;
    let stepIndex = 0;

    const onEvent = (event: SleepEvent): void => {
      if (event.type === "cycle_started") {
        sleepCard = startSleepCard();
        totalSteps = event.totalSteps;
      }
      if (event.type === "step_started") {
        stepIndex = event.index;
        progress = { percent: totalSteps > 0 ? Math.round((stepIndex / totalSteps) * 100) : 0, step: event.stepId };
      }
      sleepCard?.onEvent(event);
    };

    api.runSleepCycle({
      runtime: opts.runtime,
      level,
      fresh,
      mode,
      signal: shutdownController.signal,
      onEvent,
    })
      .then(async (result: SleepRunResult) => {
        running = false;
        progress = null;
        sleepCard?.complete();
        logInfo("sleep", `😴 Sleep finished (status=${result.status}, llmCalls=${result.llmCalls})`);
        writeSleepStatus("awake");

        if (result.status === "completed" && opts.memoryEnabled) opts.onComplete();

        if (result.status === "no_work" || result.status === "already_running" || result.status === "cancelled") {
          // Nothing new to report to the user for these terminal states.
          return;
        }

        // #844: buffer silently — don't trigger model response
        const { bufferSystemEvent } = await import("../../components/system-event-buffer.js");
        bufferSystemEvent(result.report);
      })
      .catch((err: unknown) => {
        running = false;
        progress = null;
        sleepCard?.complete();
        writeSleepStatus("awake");
        const msg = err instanceof Error ? err.message : String(err);
        logWarn("sleep", `😴 Sleep threw: ${msg}`);
      })
      .finally(() => {
        // #1287: tear down the night Dreamy session on EVERY cycle outcome.
        opts.onCycleEnd?.();
      });
  }

  return {
    get isActive() { return running; },
    get progress() { return progress; },
    startScheduled(): SleepStartResult {
      if (running) return { status: "already_running" };
      runCycle(scheduledLevel(), false, "scheduled");
      return { status: "accepted" };
    },
    startManual({ fresh, resume }): SleepStartResult {
      if (running) return { status: "already_running" };
      const level = fresh ? ("ultimate" as Level) : scheduledLevel();
      runCycle(level, fresh, resume ? "resume" : "manual");
      return { status: "accepted" };
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
