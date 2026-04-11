import { localISO } from "../utils/local-time.js";
/**
 * Self-healer heartbeat task — scans bridge log for ERROR lines.
 * Auto-fix tier: injects bounded fix command to agent (whitelisted patterns).
 * Notify tier: sends TG notification to user with occurrence count.
 */

import { readFileSync } from "node:fs";
import { logInfo } from "./logger.js";
import { getLogFile } from "./logger.js";
import type { HeartbeatTask } from "../types/memory.js";
import type { TelegramAdapter } from "../platforms/telegram/telegram-adapter.js";

/** Errors to completely ignore (not actionable). */
const BLACKLIST = [
  "-32603", "Transient error", "fetch failed",
  "[self-healer]", "[watchdog]", "[db-integrity]",
  "ECONNRESET", "ETIMEDOUT", "socket hang up",
  "auto-approved", "permission",
  "BUG REPORT",
];

/** Auto-fix tier: pattern → bounded instruction for the agent. */
const AUTO_FIX: Array<{ pattern: string; instruction: string }> = [
  { pattern: "FTS index", instruction: "Run: agentbridge-edit --rebuild-fts and report the result." },
  { pattern: "database disk image is malformed", instruction: "Run: agentbridge-edit --rebuild-fts and report the result." },
];

const NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // 60min
const AUTOFIX_COOLDOWN_MS = 30 * 60 * 1000; // 30min

interface ErrorState {
  lastNotifiedAt: number;
  count: number;
}

export function createSelfHealerTask(
  getTelegramAdapter: () => TelegramAdapter | null,
  allowedUserIds: Set<number>,
): HeartbeatTask & { enabled: boolean } {
  let lastTs = localISO();
  let bridgeStartTs = ""; // filter pre-restart errors
  const errorStates = new Map<string, ErrorState>();
  let enabled = process.env["SELFHEAL_ENABLED"] === "true";

  const task: HeartbeatTask & { enabled: boolean } = {
    name: "self-healer",
    get enabled() { return enabled; },
    set enabled(v: boolean) { enabled = v; },
    execute: async () => {
      if (!enabled) return;
      const logFile = getLogFile();
      try {
        const content = readFileSync(logFile, "utf-8");
        const lines = content.split("\n");
        const now = Date.now();

        // Find latest BRIDGE START marker — ignore errors before it
        if (!bridgeStartTs) {
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i]!.includes("BRIDGE START")) {
              bridgeStartTs = lines[i]!.slice(0, 23);
              break;
            }
          }
        }

        const adapter = getTelegramAdapter();
        const chatId = [...allowedUserIds][0];
        if (!adapter || !chatId) return;

        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]!;
          if (line.length < 24 || !line.includes(" ERROR ")) continue;
          const ts = line.slice(0, 23);
          if (ts <= lastTs) break;
          if (bridgeStartTs && ts < bridgeStartTs) continue;
          if (line.includes("TEST ")) continue;
          if (BLACKLIST.some(b => line.includes(b))) continue;

          const match = line.match(/\[([^\]]+)\] (.+)/);
          if (!match) continue;
          const errorKey = `${match[1]}:${match[2]!.slice(0, 80)}`;

          // Update count
          const state = errorStates.get(errorKey) ?? { lastNotifiedAt: 0, count: 0 };
          state.count++;
          errorStates.set(errorKey, state);

          // Check auto-fix tier
          const fix = AUTO_FIX.find(f => line.includes(f.pattern));
          if (fix) {
            if (now - state.lastNotifiedAt < AUTOFIX_COOLDOWN_MS) continue;
            state.lastNotifiedAt = now;
            adapter.injectMessage({
              platform: "telegram", channelId: String(chatId),
              sessionKey: `telegram:${chatId}`, senderId: "system",
              senderName: "Self-Healing Agent",
              text: `[SYSTEM AUTO-FIX] ${fix.instruction}`,
              timestamp: now, isGroup: false, isVoice: false,
            });
            logInfo("self-healer", `Auto-fix injected: ${errorKey.slice(0, 60)}`);
            continue;
          }

          // Notify tier — send TG notification with count
          if (now - state.lastNotifiedAt < NOTIFY_COOLDOWN_MS) continue;
          state.lastNotifiedAt = now;
          const summary = match[2]!.slice(0, 120);
          const countText = state.count > 1 ? ` (${state.count}x in last hour)` : "";
          adapter.sendNotification(String(chatId), `⚠️ [${match[1]}] ${summary}${countText}`);
          logInfo("self-healer", `Notified user: ${errorKey.slice(0, 60)} (${state.count}x)`);
        }

        // Advance watermark
        if (lines.length > 1) {
          const lastLine = lines[lines.length - 2] ?? "";
          if (lastLine.length >= 23) lastTs = lastLine.slice(0, 23);
        }

        // Cleanup old states
        for (const [key, s] of errorStates) {
          if (now - s.lastNotifiedAt > NOTIFY_COOLDOWN_MS * 2) errorStates.delete(key);
        }
      } catch { /* log file not readable — skip */ }
    },
  };
  return task;
}
