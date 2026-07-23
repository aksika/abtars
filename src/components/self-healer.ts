import { readFileSync, appendFileSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { logInfo, logDebug } from "./logger.js";
import { getLogFile } from "./logger.js";
import { abtarsHome } from "../paths.js";
import { logAndSwallow } from "./log-and-swallow.js";
import { getEnv } from "./env-schema.js";
import { localISO } from "../utils/local-time.js";
import { loadFixes, shouldAttempt, recordResult } from "./sha-tracker.js";
import type { FixRule } from "./sha-tracker.js";
import type { HeartbeatTask, HeartbeatTaskOutcome } from "../types/index.js";
import type { TelegramAdapter } from "../platforms/telegram/telegram-adapter.js";

const TAG = "self-healer";
const MAX_READ_BYTES = 1_048_576;

type LogCursor = {
  path: string;
  inode: number;
  offset: number;
  partial: string;
};

function logShaCall(errorKey: string, errorLine: string): void {
  const logPath = join(abtarsHome(), "logs", "sha-call.log");
  const entry = JSON.stringify({ ts: localISO(), errorKey, errorLine: errorLine.slice(0, 300) });
  try { appendFileSync(logPath, entry + "\n"); } catch {}
}

function logAutoFix(message: string): void {
  const dir = join(abtarsHome(), "logs");
  try { mkdirSync(dir, { recursive: true }); } catch (err) { logAndSwallow(TAG, "op", err); }
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
  let enabled = getEnv().selfhealEnabled;
  let agentRunning = false;
  const dryRun = process.env["SELFHEAL_DRY_RUN"] === "true";
  let logCursor: LogCursor | null = null;

  const task: HeartbeatTask & { enabled: boolean } = {
    name: "self-healer",
    get enabled() { return enabled; },
    set enabled(v: boolean) { enabled = v; },
    execute: async (): Promise<HeartbeatTaskOutcome> => {
      if (!enabled) return { state: "idle" };
      const logFile = getLogFile();

      try {
        const fixes = loadFixes();
        const adapter = getTelegramAdapter();
        const chatId = String([...allowedUserIds][0] ?? "");
        if (!adapter || !chatId) return { state: "idle" };

        const content = readIncremental(logFile);
        if (!content) return { state: "idle" };

        const lines = content.split("\n");
        let evaluatedCount = 0;

        if (!logCursor?.partial && lines.length === 0) return { state: "idle" };

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (line.length < 24 || !line.includes(" ERROR ")) continue;
          if (line.includes("TEST ")) continue;

          const match = line.match(/\[([^\]]+)\] (.+)/);
          if (!match) continue;
          evaluatedCount++;

          const stableMsg = match[2]!.slice(0, 80)
            .replace(/\b[0-9a-f]{8,}\b/gi, "X")
            .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[:\d.]*/g, "T")
            .replace(/\b\d{4,}\b/g, "N")
            .replace(/\s+/g, " ").trim();
          const errorKey = `${match[1]}:${stableMsg}`;

          const rule = fixes.find(f => line.includes(f.pattern));
          if (rule) {
            handleKnownFault(rule, errorKey, adapter, chatId, dryRun);
            continue;
          }

          if (!agentRunning) {
            handleUnknownFault(line, errorKey, adapter, chatId, () => { agentRunning = false; });
            if (!agentRunning) agentRunning = true;
          }
        }

        return evaluatedCount > 0
          ? { state: "ran", detail: `evaluated ${evaluatedCount} error line(s)` }
          : { state: "idle" };
      } catch (err) {
        logAndSwallow(TAG, "op", err);
        return { state: "idle" };
      }
    },
  };

  function readIncremental(logFile: string): string | null {
    try {
      const st = statSync(logFile);
      if (!logCursor) {
        logCursor = {
          path: logFile,
          inode: st.ino,
          offset: Math.max(0, st.size),
          partial: "",
        };
        return null;
      }
      if (logCursor.path !== logFile || st.ino !== logCursor.inode || st.size < logCursor.offset) {
        logCursor = {
          path: logFile,
          inode: st.ino,
          offset: 0,
          partial: "",
        };
      }

      if (st.size <= logCursor.offset) return null;

      const toRead = Math.min(st.size - logCursor.offset, MAX_READ_BYTES);
      const buf = Buffer.alloc(toRead);
      const fd = openSync(logFile, "r");
      try {
        const bytesRead = readSync(fd, buf, 0, toRead, logCursor.offset);
        logCursor.offset += bytesRead;
        const raw = logCursor.partial + buf.toString("utf-8", 0, bytesRead);
        const lastNewline = raw.lastIndexOf("\n");
        if (lastNewline === -1) {
          logCursor.partial = raw;
          return null;
        }
        const complete = raw.slice(0, lastNewline);
        logCursor.partial = raw.slice(lastNewline + 1);
        return complete;
      } finally {
        try { closeSync(fd); } catch {}
      }
    } catch {
      logCursor = null;
      return null;
    }
  }

  return task;
}

function handleKnownFault(rule: FixRule, _errorKey: string, adapter: TelegramAdapter, chatId: string, dryRun: boolean): void {
  if (!shouldAttempt("autofix-known", rule.pattern)) return;

  if (rule.action === "suppress") {
    logDebug(TAG, `Suppressed: "${rule.pattern}"`);
    return;
  }

  if (!rule.command?.length) return;

  if (dryRun) {
    logInfo(TAG, `[DRY-RUN] Would run: ${rule.command.join(" ")}`);
    return;
  }

  logInfo(TAG, `Wired fix: ${rule.command.join(" ")} (pattern: "${rule.pattern}")`);
  logAutoFix(`WIRED START: ${rule.pattern} → ${rule.command.join(" ")}`);

  const child = spawn(rule.command[0]!, rule.command.slice(1), { stdio: "ignore" });
  child.on("exit", (code) => {
    const ok = code === 0;
    recordResult("autofix-known", rule.pattern, ok, ok ? undefined : `exit ${code}`);
    logAutoFix(`WIRED ${ok ? "OK" : "FAIL"}: ${rule.pattern} (exit ${code})`);

    if (!ok) {
      if (!shouldAttempt("autofix-known", rule.pattern)) {
        notify(adapter, chatId, `⚠️ Wired fix failed 3x for "${rule.pattern}" — suppressed 24h. Manual intervention needed.`);
      }
    } else if (rule.verified === false) {
      notify(adapter, chatId, `🔧 Self-fix ran: "${rule.pattern}" → ${(rule.command ?? []).join(" ")} ✓\nRun /healing approve ${rule.pattern.slice(0, 20)} to silence.`);
    }
  });
}

function handleUnknownFault(errorLine: string, errorKey: string, adapter: TelegramAdapter, chatId: string, onDone: () => void): void {
  if (!shouldAttempt("autofix-unknown", errorKey)) return;

  const hour = new Date().getHours();
  if (hour < 7) { logDebug(TAG, `Skipping SHA dispatch — night hours (${hour}:xx)`); return; }
  try {
    const lock = JSON.parse(readFileSync(join(abtarsHome(), "bridge.lock"), "utf-8"));
    if (lock.bootType === "darkwake") { logDebug(TAG, "Skipping SHA dispatch — darkwake boot"); return; }
  } catch {}

  logInfo(TAG, `Unknown fault — dispatching agent: ${errorKey.slice(0, 60)}`);
  logAutoFix(`AGENT START: ${errorKey}`);
  logShaCall(errorKey, errorLine);

  const srcDir = join(abtarsHome(), "src/abtars");
  if (!existsSync(srcDir)) {
    try {
      mkdirSync(join(abtarsHome(), "src"), { recursive: true });
      execSync(`git clone -b dev git@github.com:aksika/abtars.git "${srcDir}"`, { timeout: 60_000, stdio: "ignore" });
    } catch {}
  }

  const prompt = `A runtime error occurred:\n"${errorLine.slice(0, 500)}"\n\nBefore investigating, check ~/.abtars/logs/sha-call.log for prior entries matching this error pattern.\nIf you find a PREVIOUS entry with a similar error pattern:\n  - This is a recurring fault you could not eliminate last time.\n  - Add a suppress rule to ~/.abtars/config/sha-policy-self.json (read existing file, append to fixes array):\n    {"pattern": "<plain substring from the error line>", "action": "suppress"}\n    Pattern is matched via substring (includes), NOT regex. Use a distinctive fragment.\n  - Report: "Recurring unfixable fault — suppressed."\n  - Do NOT attempt a fix.\n\nOtherwise, diagnose and fix it. After fixing:\n1. Report what you did (1 paragraph)\n2. If this error is likely to recur and you found a deterministic fix, write a wired rule to ~/.abtars/config/sha-policy-self.json:\n   {"pattern": "<substring>", "action": "run", "command": [...], "cooldownMin": 30}\n   Pattern is matched via substring (includes), NOT regex.\n   If the error was a one-off or no reliable automated fix exists, skip this step.\n\nIf you cannot find the root cause in the source code, tell the user:\n"This may be fixed in a newer version. Try /update to get the latest."
Do NOT attempt to fix code you don't understand.`;

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