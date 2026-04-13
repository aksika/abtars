import { localISO } from "../utils/local-time.js";
/**
 * Self-healer heartbeat task — scans bridge log for ERROR lines.
 * Auto-fix tier: spawns coding subagent with bounded instruction (from auto-fix.json).
 * Notify tier: sends TG notification to user with occurrence count.
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logWarn } from "./logger.js";
import { getLogFile } from "./logger.js";
import { agentBridgeHome } from "../paths.js";
import type { HeartbeatTask } from "../types/memory.js";
import type { TelegramAdapter } from "../platforms/telegram/telegram-adapter.js";

/** Errors to completely ignore (not actionable). */
const BLACKLIST = [
  "-32603", "Transient error", "fetch failed",
  "[self-healer]", "[watchdog]", "[db-integrity]",
  "ECONNRESET", "ETIMEDOUT", "socket hang up",
  "auto-approved", "permission",
  "BUG REPORT", "AUTO-FIX",
];

interface AutoFixRule {
  pattern: string;
  instruction: string;
  cooldownMin: number;
  enabled: boolean;
}

function loadAutoFixRules(): AutoFixRule[] {
  try {
    const p = join(agentBridgeHome(), "config", "auto-fix.json");
    const rules = JSON.parse(readFileSync(p, "utf-8")) as AutoFixRule[];
    return rules.filter(r => r.enabled && r.pattern && r.instruction);
  } catch { return []; }
}

const NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // 60min

interface ErrorState {
  lastNotifiedAt: number;
  count: number;
}

function logAutoFix(message: string): void {
  const dir = join(agentBridgeHome(), "logs");
  try { mkdirSync(dir, { recursive: true }); } catch { /* */ }
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(join(dir, `autofix-${date}.log`), `${localISO()} ${message}\n`);
}

export function createSelfHealerTask(
  getTelegramAdapter: () => TelegramAdapter | null,
  allowedUserIds: Set<number>,
): HeartbeatTask & { enabled: boolean } {
  let lastTs = localISO();
  let bridgeStartTs = "";
  const errorStates = new Map<string, ErrorState>();
  let enabled = process.env["SELFHEAL_ENABLED"] === "true";
  let autoFixRunning = false;

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
        const rules = loadAutoFixRules();

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

          const state = errorStates.get(errorKey) ?? { lastNotifiedAt: 0, count: 0 };
          state.count++;
          errorStates.set(errorKey, state);

          // Check auto-fix rules
          const rule = rules.find(r => line.includes(r.pattern));
          if (rule && !autoFixRunning) {
            const cooldownMs = rule.cooldownMin * 60 * 1000;
            if (now - state.lastNotifiedAt < cooldownMs) continue;
            state.lastNotifiedAt = now;

            // Spawn coding subagent in background
            autoFixRunning = true;
            logInfo("self-healer", `Auto-fix: spawning coding subagent for "${rule.pattern}"`);
            logAutoFix(`START: ${rule.pattern} → ${rule.instruction}`);

            (async () => {
              const timeout = setTimeout(() => { autoFixRunning = false; }, 5 * 60 * 1000);
              try {
                const { SubagentRuntime } = await import("./subagent-runtime.js");
                const runtime = new SubagentRuntime();
                const result = await runtime.complete("coding", rule.instruction);
                await runtime.shutdown();
                const summary = (result || "(no output)").slice(0, 200);
                logAutoFix(`DONE: ${rule.pattern} → ${summary}`);
                adapter.sendNotification(String(chatId), `🔧 Auto-fix: ${rule.pattern}\n${summary}`);
                logInfo("self-healer", `Auto-fix done: ${rule.pattern}`);
              } catch (err) {
                // Transport failed — fall back to notify
                const msg = err instanceof Error ? err.message : String(err);
                logWarn("self-healer", `Auto-fix transport failed, notifying user: ${msg}`);
                logAutoFix(`FAILED: ${rule.pattern} → ${msg}`);
                adapter.sendNotification(String(chatId), `⚠️ Auto-fix failed for "${rule.pattern}": ${msg.slice(0, 100)}`);
              } finally {
                clearTimeout(timeout);
                autoFixRunning = false;
              }
            })();
            continue;
          }

          // Notify tier
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
