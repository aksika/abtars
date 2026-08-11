import type { HeartbeatTask } from "../types/index.js";

export function createUserSessionExpiryTask(): HeartbeatTask {
  return {
    name: "user-session-expiry",
    execute: async () => {
      const { spin } = await import("./spin.js");
      const sessions = spin.listAllSessions();
      if (!sessions.length) return { state: "idle" as const };
      const now = Date.now();
      let expired = 0;
      for (const session of sessions) {
        if (session.idleTimeoutMs === Infinity) continue;
        if (session.status !== "ready") continue;
        if (!session.transport) continue;
        if (now - session.lastActiveAt > session.idleTimeoutMs) {
          spin.destroySession(session.userId, session.id);
          expired++;
        }
      }
      return expired > 0
        ? { state: "ran" as const, detail: `expired ${expired} session(s)` }
        : { state: "idle" as const };
    },
  };
}