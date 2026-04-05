/**
 * Watchdog heartbeat task — detects stuck ACP prompts and recovers.
 * Cases: dead process, hung tool, endless loop, silent timeout.
 */

import { logWarn } from "./logger.js";
import { writeRestartReason } from "./restart-reason.js";
import type { AcpTransport } from "./transport/acp-transport.js";
import type { HeartbeatTask } from "../types/memory.js";

export function createWatchdogTask(transport: AcpTransport, requestShutdown: () => void): HeartbeatTask {
  let l1Done = false;
  let lastActionAt = 0;
  const COOLDOWN = 60 * 60 * 1000;
  const TOOL_TIMEOUT = (parseInt(process.env["WATCHDOG_TOOL_TIMEOUT_SEC"] ?? "180", 10)) * 1000;
  const SILENT_TIMEOUT = (parseInt(process.env["WATCHDOG_SILENT_SEC"] ?? "300", 10)) * 1000;
  const ENDLESS_TIMEOUT = (parseInt(process.env["WATCHDOG_ENDLESS_SEC"] ?? "600", 10)) * 1000;

  return {
    name: "watchdog",
    execute: async () => {
      if (transport.promptStartedAt <= transport.lastSuccessAt) {
        l1Done = false;
        return;
      }

      const now = Date.now();
      if (now - lastActionAt < COOLDOWN && l1Done) return;

      const silentMs = now - transport.lastActivityAt;
      const totalMs = now - transport.promptStartedAt;

      // Case 2: Process dead
      if (!transport.isConnected) {
        logWarn("watchdog", `[Case 2] Process dead — reinit + re-send`);
        lastActionAt = now;
        writeRestartReason("watchdog: process dead");
        try {
          await transport.initialize();
          if (transport.lastPromptText) await transport.sendPrompt(transport.lastSessionKey, transport.lastPromptText);
        } catch { requestShutdown(); }
        return;
      }

      // Case 1: Tool hung > 3min
      if (transport.toolInFlight && now - transport.toolInFlight.startedAt > TOOL_TIMEOUT) {
        const title = transport.toolInFlight.title;
        const dur = Math.round((now - transport.toolInFlight.startedAt) / 1000);
        logWarn("watchdog", `[Case 1] Tool "${title}" hung ${dur}s — interrupting`);
        lastActionAt = now;
        try {
          await transport.sendInterrupt();
          transport.toolInFlight = null;
          if (!l1Done) {
            await transport.sendPrompt(transport.lastSessionKey, `[SYSTEM] Your tool call "${title}" was interrupted after ${dur} seconds. Try a different approach.`);
            l1Done = true;
          }
        } catch {
          logWarn("watchdog", "[Case 1] Interrupt failed — resetting");
          await transport.resetSession(transport.lastSessionKey).catch(() => {});
          if (transport.lastPromptText) await transport.sendPrompt(transport.lastSessionKey, transport.lastPromptText).catch(() => {});
        }
        return;
      }

      // Case 4: Active but endless > 10min
      if (silentMs < SILENT_TIMEOUT && totalMs > ENDLESS_TIMEOUT) {
        logWarn("watchdog", `[Case 4] Active but endless (${Math.round(totalMs / 1000)}s) — interrupting`);
        lastActionAt = now;
        try {
          await transport.sendInterrupt();
          if (!l1Done) {
            await transport.sendPrompt(transport.lastSessionKey, "[SYSTEM] Interrupted — you appeared stuck in a loop. Please wrap up and respond to the user.");
            l1Done = true;
          }
        } catch {
          await transport.resetSession(transport.lastSessionKey).catch(() => {});
          if (transport.lastPromptText) await transport.sendPrompt(transport.lastSessionKey, transport.lastPromptText).catch(() => {});
        }
        return;
      }

      // Case 3: Silent > 5min (transient/rate limit)
      if (silentMs > SILENT_TIMEOUT && !transport.toolInFlight) {
        if (!l1Done) {
          logWarn("watchdog", `[Case 3] Silent ${Math.round(silentMs / 1000)}s — re-sending prompt`);
          l1Done = true;
          lastActionAt = now;
          try {
            if (transport.lastPromptText) await transport.sendPrompt(transport.lastSessionKey, transport.lastPromptText);
          } catch {
            logWarn("watchdog", "[Case 3] Re-send failed — resetting");
            await transport.resetSession(transport.lastSessionKey).catch(() => {});
            if (transport.lastPromptText) await transport.sendPrompt(transport.lastSessionKey, transport.lastPromptText).catch(() => {});
          }
        } else {
          logWarn("watchdog", `[Case 3] Still silent after re-send — L2: restarting bridge`);
          writeRestartReason(`watchdog-restart: silent after re-send, ${Math.round(silentMs / 1000)}s`);
          requestShutdown();
        }
        return;
      }
    },
  };
}
