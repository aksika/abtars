import type { PowerSafetyProbe, PowerSafetyResult, PowerBlockReason } from "./types.js";

export interface PowerSafetyReaders {
  lastPromptAt: () => number;
  isAnyExecutionActive: (excludeEntryId?: string) => boolean;
  isSleepCycleActive: () => boolean;
  isTaskQueueEmpty: () => boolean;
  isMaintenanceActive: () => boolean;
  isTransitionActive: () => boolean;
  isPlatformSupported: () => boolean;
}

export function createPowerSafetyProbe(readers: PowerSafetyReaders): PowerSafetyProbe {
  return {
    inspect(entry): PowerSafetyResult {
      const reasons: PowerBlockReason[] = [];
      const now = Date.now();

      const idleMinutes = entry.idleMinutes ?? 20;
      const lastActivity = readers.lastPromptAt();
      const idleMs = now - lastActivity;

      if (idleMs < idleMinutes * 60 * 1000) {
        reasons.push("recent_user_activity");
      }

      if (readers.isAnyExecutionActive(entry.currentEntryId)) {
        reasons.push("active_execution");
      }

      if (readers.isSleepCycleActive()) {
        reasons.push("sleep_cycle_active");
      }

      if (!readers.isTaskQueueEmpty()) {
        reasons.push("task_queue_busy");
      }

      if (readers.isMaintenanceActive()) {
        reasons.push("maintenance_active");
      }

      if (readers.isTransitionActive()) {
        reasons.push("transition_active");
      }

      if (!readers.isPlatformSupported()) {
        reasons.push("unsupported_platform");
      }

      if (entry.latestLocalTime) {
        const localNow = new Date();
        const [limitH, limitM] = entry.latestLocalTime.split(":").map(Number);
        const limitMinutes = limitH! * 60 + limitM!;
        const nowMinutes = localNow.getHours() * 60 + localNow.getMinutes();
        if (nowMinutes >= limitMinutes) {
          reasons.push("outside_window");
        }
      }

      return {
        safe: reasons.length === 0,
        reasons,
        checkedAt: now,
      };
    },
  };
}
