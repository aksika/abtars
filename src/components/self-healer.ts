/**
 * Self-healer heartbeat task — scans bridge log for ERROR lines
 * and injects bug reports to the agent via Telegram.
 */

import { readFileSync } from "node:fs";
import { logInfo } from "./logger.js";
import { getLogFile } from "./logger.js";
import type { HeartbeatTask } from "../types/memory.js";
import type { TelegramAdapter } from "../platforms/telegram/telegram-adapter.js";

const SELFHEAL_BLACKLIST = [
  "-32603", "Transient error", "fetch failed",
  "[self-healer]", "[watchdog]", "[db-integrity]",
  "ECONNRESET", "ETIMEDOUT", "socket hang up",
  "auto-approved", "permission",
  "BUG REPORT", "[agentbridge-sleep]",
];

export function createSelfHealerTask(
  getTelegramAdapter: () => TelegramAdapter | null,
  allowedUserIds: Set<number>,
): HeartbeatTask {
  const maxReports = parseInt(process.env["SELFHEAL_MAX_REPORTS"] ?? "1", 10);
  const cooldownMs = (parseInt(process.env["SELFHEAL_COOLDOWN_MIN"] ?? "30", 10)) * 60 * 1000;
  let lastTs = new Date().toISOString().slice(0, 23);
  const seen = new Map<string, number>();

  return {
    name: "self-healer",
    execute: async () => {
      const logFile = getLogFile();
      try {
        const content = readFileSync(logFile, "utf-8");
        const lines = content.split("\n");
        const now = Date.now();
        let reported = 0;

        for (let i = lines.length - 1; i >= 0 && reported < maxReports; i--) {
          const line = lines[i]!;
          if (line.length < 24 || !line.includes(" ERROR ")) continue;
          const ts = line.slice(0, 23);
          if (ts <= lastTs) break;
          if (line.includes("TEST ")) continue;
          if (SELFHEAL_BLACKLIST.some(b => line.includes(b))) continue;

          const match = line.match(/\[([^\]]+)\] (.+)/);
          if (!match) continue;
          const errorKey = `${match[1]}:${match[2]!.slice(0, 80)}`;

          const lastSeen = seen.get(errorKey);
          if (lastSeen && now - lastSeen < cooldownMs) continue;
          seen.set(errorKey, now);

          const adapter = getTelegramAdapter();
          if (adapter) {
            const chatId = [...allowedUserIds][0];
            if (chatId) {
              adapter.injectMessage({
                platform: "telegram",
                channelId: String(chatId),
                sessionKey: `telegram:${chatId}`,
                senderId: "system",
                senderName: "Self-Healing Agent",
                text: `[SYSTEM BUG REPORT] ${line.slice(0, 500)}`,
                timestamp: now,
                isGroup: false,
                isVoice: false,
              });
              reported++;
              logInfo("self-healer", `Reported error to KP: ${errorKey.slice(0, 80)}`);
            }
          }
        }

        if (lines.length > 1) {
          const lastLine = lines[lines.length - 2] ?? "";
          if (lastLine.length >= 23) lastTs = lastLine.slice(0, 23);
        }

        for (const [key, ts] of seen) {
          if (now - ts > cooldownMs * 2) seen.delete(key);
        }
      } catch { /* log file not readable — skip */ }
    },
  };
}
