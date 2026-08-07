import { randomUUID } from "node:crypto";
import type { SystemTaskResult } from "../../components/tasks/system-task-registry.js";
import type { PowerSafetyProbe, PowerAdapter, HardwareSleepInspection, HardwareSleepInspectEntry, PowerTransitionState } from "./types.js";
import { PowerTransitionStore } from "./power-transition-store.js";

/** Defaults matching the canonical paused template entry. */
const DEFAULTS = {
  idleMinutes: 20,
  retryMinutes: 10,
  latestLocalTime: "05:30",
  expectedWakeTime: "07:55",
} as const;

/** Margin after expected wake before the transition marker expires. */
const POST_WAKE_MARGIN_MS = 2 * 3600_000;

/** Compute the anticipated wake timestamp from a local-time string like "07:55". */
function computeExpectedWakeAt(expectedWakeTime: string): number {
  const [h, m] = expectedWakeTime.split(":").map(Number);
  const now = new Date();
  const wake = new Date(now);
  wake.setHours(h!, m!, 0, 0);
  if (wake.getTime() <= now.getTime()) {
    wake.setDate(wake.getDate() + 1);
  }
  return wake.getTime();
}

export class HardwareSleepController {
  constructor(
    private readonly probe: PowerSafetyProbe,
    private readonly adapter: PowerAdapter | null,
    private readonly transitionStore: PowerTransitionStore,
    private readonly isTestRuntime: () => boolean = () =>
      !!(process.env.VITEST || process.env.NODE_ENV === "test"),
  ) {}

  async inspect(entry: Readonly<HardwareSleepInspectEntry>): Promise<HardwareSleepInspection> {
    const idleMinutes = entry.idleMinutes ?? DEFAULTS.idleMinutes;
    const latestLocalTime = entry.latestLocalTime ?? DEFAULTS.latestLocalTime;
    const expectedWakeTime = entry.expectedWakeTime ?? DEFAULTS.expectedWakeTime;
    const safety = this.probe.inspect({ idleMinutes, latestLocalTime, currentEntryId: entry.id });
    const wake = this.adapter ? await this.adapter.verifyWakeSchedule(expectedWakeTime) : null;
    const transition = this.transitionStore.read();
    return {
      safe: safety.safe,
      reasons: safety.reasons,
      wake,
      transition,
      platform: this.adapter?.platform ?? "unsupported",
      suspendCommand: this.adapter ? "pmset sleepnow" : "none",
    };
  }

  async attempt(entry: Readonly<HardwareSleepInspectEntry>): Promise<SystemTaskResult> {
    if (!this.adapter) {
      return { status: "failed", error: "hardware-sleep not supported on this platform" };
    }

    const idleMinutes = entry.idleMinutes ?? DEFAULTS.idleMinutes;
    const retryMinutes = entry.retryMinutes ?? DEFAULTS.retryMinutes;
    const latestLocalTime = entry.latestLocalTime ?? DEFAULTS.latestLocalTime;
    const expectedWakeTime = entry.expectedWakeTime ?? DEFAULTS.expectedWakeTime;

    const now = new Date();
    const [limitH, limitM] = latestLocalTime.split(":").map(Number);
    const limitMinutes = limitH! * 60 + limitM!;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    if (nowMinutes >= limitMinutes) {
      return { status: "noop", detail: "window_expired" };
    }

    const wake = await this.adapter.verifyWakeSchedule(expectedWakeTime);
    if (!wake.verified) {
      return { status: "failed", error: `wake not verified: ${wake.reason ?? "unknown"}` };
    }

    const safety = this.probe.inspect({ idleMinutes, latestLocalTime, currentEntryId: entry.id });
    if (!safety.safe) {
      const retryAt = Date.now() + retryMinutes * 60 * 1000;
      return { status: "deferred", retryAt, detail: `blocked: ${safety.reasons.join(", ")}` };
    }

    const expectedWakeAt = computeExpectedWakeAt(expectedWakeTime);
    const attemptId = randomUUID();
    const transition: PowerTransitionState = {
      state: "suspending",
      taskId: "hardware-sleep",
      requestedAt: Date.now(),
      expiresAt: expectedWakeAt + POST_WAKE_MARGIN_MS,
      expectedWakeAt,
      // #1517: unique persisted attempt marker so the second safety check can
      // distinguish this attempt's own claim from a foreign or replacement one.
      attemptId,
    };
    this.transitionStore.write(transition);

    const safety2 = this.probe.inspect({ idleMinutes, latestLocalTime, currentEntryId: entry.id }, attemptId);
    if (!safety2.safe) {
      this.transitionStore.clearIfOwned(attemptId);
      const retryAt = Date.now() + retryMinutes * 60 * 1000;
      return { status: "deferred", retryAt, detail: `second-check blocked: ${safety2.reasons.join(", ")}` };
    }

    if (this.isTestRuntime()) {
      this.transitionStore.clearIfOwned(attemptId);
      return { status: "failed", error: "hardware suspend disabled under test runtime" };
    }

    try {
      await this.adapter.suspend();
      // #1603: for this action, issuing the suspend command IS completion —
      // the old `accepted` variant meant "started", and the settler mapped
      // that to success anyway. `ok` says so truthfully.
      return { status: "ok", detail: "suspend command issued" };
    } catch (err) {
      this.transitionStore.clearIfOwned(attemptId);
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
