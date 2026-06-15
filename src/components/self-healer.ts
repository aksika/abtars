/**
 * Self-healer heartbeat task — scans bridge log for ERROR lines (#954).
 *
 * Two-state dispatch:
 * 1. Known fault (pattern in sha-policy fixes) → wired command[], no LLM
 * 2. Unknown fault (no matching rule) → one-shot agent via Spin (if SELFHEAL_ENABLED)
 *
 * All gating via sha-tracker. No inline state.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { logInfo, logDebug } from "./logger.js";
import { getLogFile } from "./logger.js";
import { abtarsHome } from "../paths.js";
import { logAndSwallow } from "./log-and-swallow.js";
import { getEnv } from "./env-schema.js";
import { localISO } from "../utils/local-time.js";
import { loadFixes, shouldAttempt, recordResult } from "./sha-tracker.js";
import type { FixRule } from "./sha-tracker.js";
import type { HeartbeatTask } from "abmind";
import type { TelegramAdapter } from "../platforms/telegram/telegram-adapter.js";

/** Write SHA dispatch to sha-call.log (model reads this for recurrence detection). */
function logShaCall(errorKey: string, errorLine: string): void {
  const logPath = join(abtarsHome(), "logs", "sha-call.log");
  const entry = JSON.stringify({ ts: localISO(), errorKey, errorLine: errorLine.slice(0, 300) });
  try { appendFileSync(logPath, entry + "\n"); } catch {}
}

// Known-noise patterns are in sha-policy.json (seeded) — no hardcoded list.

function logAutoFix(message: string): void {
  const dir = join(abtarsHome(), "logs");
  try { mkdirSync(dir, { recursive: true }); } catch (err) { logAndSwallow("self_healer", "op", err); }
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(join(dir, `autofix-${date}.log`), `${localISO()} ${message}\n`);
}

function notify(adapter: TelegramAdapter, chatId: string, msg: string): void {
  try { adapter.sendNotification(chatId, msg); } catch {}
}

export function createSelfHealerTask(
  getTelegramAdapter: () => TelegramAdapter | null,
  allowedUserIds: Set<number>,
): HeartbeatTask & { enabled: boolean } {
  let lastTs = localISO();
  let bridgeStartTs = "";
  let enabled = getEnv().selfhealEnabled;
  let agentRunning = false;
  const dryRun = process.env["SELFHEAL_DRY_RUN"] === "true";

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
        const fixes = loadFixes();

        if (!bridgeStartTs) {
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i]!.includes("BRIDGE START")) { bridgeStartTs = lines[i]!.slice(0, 23); break; }
          }
        }

        const adapter = getTelegramAdapter();
        const chatId = String([...allowedUserIds][0] ?? "");
        if (!adapter || !chatId) return;

        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]!;
          if (line.length < 24 || !line.includes(" ERROR ")) continue;
          const ts = line.slice(0, 23);
          if (ts <= lastTs) break;
          if (bridgeStartTs && ts < bridgeStartTs) continue;
          if (line.includes("TEST ")) continue;

          const match = line.match(/\[([^\]]+)\] (.+)/);
          if (!match) continue;
          const errorKey = `${match[1]}:${match[2]!.slice(0, 80)}`;

          // Try to match a wired fix rule
          const rule = fixes.find(f => line.includes(f.pattern));
          if (rule) {
            handleKnownFault(rule, errorKey, adapter, chatId, dryRun);
            continue;
          }

          // Unknown fault — agent path (one-shot)
          if (!agentRunning) {
            handleUnknownFault(line, errorKey, adapter, chatId, () => { agentRunning = false; });
            if (!agentRunning) agentRunning = true; // set after dispatch
          }
        }

        // Advance watermark
        if (lines.length > 1) {
          const lastLine = lines[lines.length - 2] ?? "";
          if (lastLine.length >= 23) lastTs = lastLine.slice(0, 23);
        }
      } catch (err) { logAndSwallow("self_healer", "op", err); }
    },
  };
  return task;
}

function handleKnownFault(rule: FixRule, _errorKey: string, adapter: TelegramAdapter, chatId: string, dryRun: boolean): void {
  if (!shouldAttempt("autofix-known", rule.pattern)) return;

  // Suppress: known noise, skip silently
  if (rule.action === "suppress") {
    logDebug("self-healer", `Suppressed: "${rule.pattern}"`);
    return;
  }

  if (!rule.command?.length) return;

  if (dryRun) {
    logInfo("self-healer", `[DRY-RUN] Would run: ${rule.command.join(" ")}`);
    return;
  }

  logInfo("self-healer", `Wired fix: ${rule.command.join(" ")} (pattern: "${rule.pattern}")`);
  logAutoFix(`WIRED START: ${rule.pattern} → ${rule.command.join(" ")}`);

  const child = spawn(rule.command[0]!, rule.command.slice(1), { stdio: "ignore" });
  child.on("exit", (code) => {
    const ok = code === 0;
    recordResult("autofix-known", rule.pattern, ok, ok ? undefined : `exit ${code}`);
    logAutoFix(`WIRED ${ok ? "OK" : "FAIL"}: ${rule.pattern} (exit ${code})`);

    if (!ok) {
      // Check if we hit maxRetries — notify user
      if (!shouldAttempt("autofix-known", rule.pattern)) {
        notify(adapter, chatId, `⚠️ Wired fix failed 3x for "${rule.pattern}" — suppressed 24h. Manual intervention needed.`);
      }
    } else if (rule.verified === false) {
      // Unverified self-rule first success — notify
      notify(adapter, chatId, `🔧 Self-fix ran: "${rule.pattern}" → ${rule.command.join(" ")} ✓\nRun /healing approve ${rule.pattern.slice(0, 20)} to silence.`);
    }
  });
}

function handleUnknownFault(errorLine: string, errorKey: string, adapter: TelegramAdapter, chatId: string, onDone: () => void): void {
  if (!shouldAttempt("autofix-unknown", errorKey)) return;

  logInfo("self-healer", `Unknown fault — dispatching agent: ${errorKey.slice(0, 60)}`);
  logAutoFix(`AGENT START: ${errorKey}`);
  logShaCall(errorKey, errorLine);

  const prompt = `A runtime error occurred:\n"${errorLine.slice(0, 500)}"\n\nBefore investigating, check ~/.abtars/logs/sha-call.log for prior entries matching this error pattern.\nIf you find a PREVIOUS entry with a similar error pattern:\n  - This is a recurring fault you could not eliminate last time.\n  - Add a suppress rule to ~/.abtars/config/sha-policy-self.json (read existing file, append to fixes array):\n    {"pattern": "<regex matching the error>", "action": "suppress", "cooldownMin": 60, "report": "Recurring transient — suppressed.", "verified": true, "createdAt": "<now>"}\n  - Report: "Recurring unfixable fault — suppressed."\n  - Do NOT attempt a fix.\n\nOtherwise, diagnose and fix it. After fixing:\n1. Report what you did (1 paragraph)\n2. If this error is likely to recur and you found a deterministic fix, write a wired rule to ~/.abtars/config/sha-policy-self.json:\n   {"pattern": "...", "action": "run", "command": [...], "cooldownMin": 30}\n   If the error was a one-off or no reliable automated fix exists, skip this step.`;

  const timeout = setTimeout(() => { onDone(); }, 5 * 60_000);

  (async () => {
    try {
      const { spin } = await import("./spin.js");
      const { result } = await spin.dispatchAwait({ type: "H", goal: prompt, title: `SHA: ${errorKey.slice(0, 20)}`, source: "agent" });
      recordResult("autofix-unknown", errorKey, true);
      logAutoFix(`AGENT OK: ${errorKey} → ${result.slice(0, 200)}`);
      notify(adapter, chatId, `🧠 SHA agent fixed: ${errorKey.slice(0, 40)}\n${result.slice(0, 300)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordResult("autofix-unknown", errorKey, false, msg);
      logAutoFix(`AGENT FAIL: ${errorKey} → ${msg}`);
      notify(adapter, chatId, `⚠️ SHA agent failed: ${errorKey.slice(0, 40)}\n${msg.slice(0, 200)}`);
    } finally {
      clearTimeout(timeout);
      onDone();
    }
  })();
}
