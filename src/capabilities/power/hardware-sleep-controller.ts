import type { SystemTaskResult } from "../../components/tasks/system-task-registry.js";
import type { CronEntry } from "../../components/tasks/task-types.js";
import type { PowerSafetyProbe, PowerAdapter, HardwareSleepInspection, PowerTransitionState } from "./types.js";
import { PowerTransitionStore } from "./power-transition-store.js";

const TRANSITION_TTL_MS = 12 * 3600_000; // 12 hours max

export class HardwareSleepController {
  constructor(
    private readonly probe: PowerSafetyProbe,
    private readonly adapter: PowerAdapter | null,
    private readonly transitionStore: PowerTransitionStore,
  ) {}

  async inspect(entry: Readonly<CronEntry>): Promise<HardwareSleepInspection> {
    const idleMinutes = entry.idleMinutes ?? 20;
    const latestLocalTime = entry.latestLocalTime ?? "05:30";
    const safety = this.probe.inspect({ idleMinutes, latestLocalTime });
    const wake = this.adapter ? await this.adapter.verifyWakeSchedule(entry.expectedWakeTime ?? "07:55") : null;
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

  async attempt(entry: Readonly<CronEntry>): Promise<SystemTaskResult> {
    if (!this.adapter) {
      return { status: "failed", error: "hardware-sleep not supported on this platform" };
    }

    const idleMinutes = entry.idleMinutes ?? 20;
    const retryMinutes = entry.retryMinutes ?? 10;
    const latestLocalTime = entry.latestLocalTime ?? "05:30";
    const expectedWakeTime = entry.expectedWakeTime ?? "07:55";

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

    const safety = this.probe.inspect({ idleMinutes, latestLocalTime });
    if (!safety.safe) {
      const retryAt = Date.now() + retryMinutes * 60 * 1000;
      return { status: "deferred", retryAt, detail: `blocked: ${safety.reasons.join(", ")}` };
    }

    const transition: PowerTransitionState = {
      state: "suspending",
      taskId: entry.id,
      requestedAt: Date.now(),
      expiresAt: Date.now() + TRANSITION_TTL_MS,
      expectedWakeAt: Date.now() + 8 * 3600_000,
    };
    this.transitionStore.write(transition);

    const safety2 = this.probe.inspect({ idleMinutes, latestLocalTime });
    if (!safety2.safe) {
      this.transitionStore.clear();
      const retryAt = Date.now() + retryMinutes * 60 * 1000;
      return { status: "deferred", retryAt, detail: `second-check blocked: ${safety2.reasons.join(", ")}` };
    }

    try {
      await this.adapter.suspend();
      return { status: "accepted", detail: "suspend command issued" };
    } catch (err) {
      this.transitionStore.clear();
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
