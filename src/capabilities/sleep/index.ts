import type { AbmindClient } from "abmind";
import { getEnv } from "../../components/env-schema.js";
import { logInfo, logWarn, logError } from "../../components/logger.js";
import { writeSleepStatus } from "../../components/transport/bridge-lock-transport.js";
import { startSleepCard, type SleepCard } from "./sleep-card.js";
import type { CapabilityApi } from "../capability.js";

export type SleepUnavailableCode =
  | "memory_disabled"
  | "abmind_not_loaded"
  | "daemon_not_connected"
  | "heartbeat_unavailable"
  | "sleep_not_initialized";

export interface SleepUnavailable {
  status: "unavailable";
  code: SleepUnavailableCode;
  reason: string;
}

export interface SleepOpts {
  client: AbmindClient;
  memoryEnabled: boolean;
  onComplete: () => void;
  onCycleEnd?: () => void;
  allocateSleepSession?: (name: string) => void;
  sessionManager: { spin: (opts: { type: string; prompt: string; sessionId?: string; timeoutMs: number; await: boolean }) => Promise<{ result?: string; sessionId?: string }> };
  bufferSystemEvent: (report: string) => void | Promise<void>;
}

export type SleepStartResult =
  | { status: "accepted" }
  | { status: "already_running" }
  | SleepUnavailable;

export function unavailable(code: SleepUnavailableCode): SleepUnavailable {
  const reasons: Record<SleepUnavailableCode, string> = {
    memory_disabled: "memory is disabled",
    abmind_not_loaded: "abmind did not initialize during boot",
    daemon_not_connected: "abmind daemon is not connected",
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
  readonly isActive: boolean;
  readonly progress: SleepProgress | null;
  startScheduled(): SleepStartResult;
  startManual(options: { fresh: boolean; resume: boolean }): SleepStartResult;
}

const POLL_INTERVAL_MS = 3000;
const EVENTS_LIMIT = 50;
const RUNTIME_NEXT_WAIT_MS = 30000;

export function createSleepHandle(opts: SleepOpts): SleepHandle {
  const { client } = opts;
  let running = false;
  let progress: SleepProgress | null = null;
  let currentRunId: string | null = null;
  let abortController = new AbortController();
  let nightSessionId: string | undefined;
  let leaseId: string | undefined;

  function cleanup(): void {
    running = false;
    progress = null;
    currentRunId = null;
    writeSleepStatus("awake");
  }

  async function providerPump(): Promise<void> {
    try {
      const openResult = await client.sleep.runtime.open("abtars");
      if (openResult.status !== "ok" || !openResult.leaseId) {
        logWarn("sleep", `Runtime provider open failed: ${openResult.status}`);
        return;
      }
      leaseId = openResult.leaseId;

      while (!abortController.signal.aborted && leaseId) {
        const nextResult = await client.sleep.runtime.next(leaseId, RUNTIME_NEXT_WAIT_MS);
        if (nextResult.status === "closed" || nextResult.status === "lease_expired") break;
        if (nextResult.heartbeat) continue;
        if (nextResult.status === "no_request") continue;

        const req = nextResult.completionRequest;
        if (!req) continue;

        try {
          const spinResult = await opts.sessionManager.spin({
            type: "D",
            prompt: req.prompt,
            sessionId: nightSessionId,
            timeoutMs: Math.max(5000, req.deadline - Date.now()),
            await: true,
          });
          if (spinResult.sessionId && !nightSessionId) nightSessionId = spinResult.sessionId;

          const completeResult = await client.sleep.runtime.complete(leaseId, req.completionId, spinResult.result ?? "");
          if (completeResult.status !== "ok") {
            logWarn("sleep", `Completion rejected: ${completeResult.status}`);
          }
        } catch (spinErr) {
          logWarn("sleep", `Model completion failed: ${(spinErr as Error).message}`);
          try {
            await client.sleep.runtime.fail(leaseId, req.completionId, "model_error");
          } catch { /* best effort */ }
        }
      }
    } catch (err) {
      logError("sleep", "Runtime provider pump error", err);
    } finally {
      if (leaseId) {
        try { await client.sleep.runtime.close(leaseId); } catch { /* best effort */ }
        leaseId = undefined;
      }
    }
  }

  async function eventPoller(): Promise<void> {
    let afterSeq = 0;
    let sleepCard: SleepCard | null = null;

    while (!abortController.signal.aborted && currentRunId) {
      try {
        const eventsResult = await client.sleep.events(afterSeq, EVENTS_LIMIT, POLL_INTERVAL_MS);
        currentRunId = eventsResult.runId;

        if (!sleepCard && eventsResult.events.length > 0) {
          sleepCard = startSleepCard();
        }

        for (const ev of eventsResult.events) {
          // The server returns events with seq > afterSeq, so keep the last
          // seen sequence number rather than skipping the next event.
          afterSeq = ev.seq;
          if (ev.event.type === "cycle_started") {
            progress = { percent: 0, step: "starting" };
          }
          if (ev.event.type === "step_started") {
            progress = {
              percent: "totalSteps" in ev.event ? Math.round((ev.seq / (ev.event as any).totalSteps) * 100) : 50,
              step: ev.event.detail ?? "running",
            };
          }
          sleepCard?.onEvent({ seq: ev.seq, at: ev.at, type: ev.event.type, detail: ev.event.detail } as any);
        }

        if (eventsResult.terminal) {
          break;
        }
      } catch {
        break;
      }
    }

    sleepCard?.complete();
  }

  function startRun(mode: "scheduled" | "manual" | "resume", level: string, fresh?: boolean): SleepStartResult {
    if (running) return { status: "already_running" };
    running = true;
    progress = { percent: 0, step: "starting" };
    abortController = new AbortController();
    writeSleepStatus("sleeping");
    logInfo("sleep", `😴 Sleep starting (mode=${mode}, client-backed)`);

    if (opts.allocateSleepSession) {
      const dateStr = new Date().toISOString().slice(0, 10);
      opts.allocateSleepSession(`Sleep ${dateStr}`);
    }

    const startPromise = mode === "resume"
      ? client.sleep.resume(undefined, level)
      : client.sleep.start(mode, level, fresh);

    startPromise.then((result: { status: string; runId?: string; reason?: string }) => {
      if (result.status === "accepted" && result.runId) {
        currentRunId = result.runId;
        providerPump().finally(() => { cleanup(); opts.onCycleEnd?.(); });
        eventPoller().catch(() => {});
      } else {
        cleanup();
        opts.onCycleEnd?.();
        logWarn("sleep", `Sleep not accepted: ${result.status}${result.reason ? ": " + result.reason : ""}`);
      }
    }).catch((err: unknown) => {
      cleanup();
      opts.onCycleEnd?.();
      logWarn("sleep", `Sleep start failed: ${(err as Error).message}`);
    });

    return { status: "accepted" };
  }

  return {
    get isActive() { return running; },
    get progress() { return progress; },
    startScheduled(): SleepStartResult {
      const env = getEnv();
      const level = env.sleepQuality ?? "normal";
      return startRun("scheduled", level);
    },
    startManual({ fresh, resume }): SleepStartResult {
      const env = getEnv();
      const level = fresh ? "ultimate" : (env.sleepQuality ?? "normal");
      return startRun(resume ? "resume" : "manual", level, fresh);
    },
  };
}

export function register(_api: CapabilityApi): void {
}
