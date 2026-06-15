import { spawn } from "node:child_process";
import { readFileSync, readdirSync, unlinkSync} from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { logInfo} from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { getEnv } from "../env-schema.js";
import { writeSleepStatus, readBridgeLockField, writeForceSleep } from "../transport/bridge-lock-transport.js";
import type { CommandContext } from "./types.js";
import { setWakeInhibitPid } from "./registry.js";

const TAG = "cmd";

export async function handleSleep(_text: string, ctx: CommandContext): Promise<boolean> {
  const sleepStatus = readBridgeLockField<string>("sleepStatus") ?? "awake";
  const progress = ctx.sleepProgress?.();
  const force = readBridgeLockField<string>("forceSleep");
  const bedTime = getEnv().bedTime.raw;
  const auditDir = ctx.memoryConfig?.memoryDir ? join(ctx.memoryConfig.memoryDir, "sleep") : "";
  const lock = auditDir ? readLatestSleepLock(auditDir) : null;

  const lines: string[] = ["😴 Sleep status"];
  const stateLabel = progress ? `🧠 Sleep cycle running (${progress.step}, ${progress.percent}%)` : sleepStatus === "sleeping" ? "😴 Asleep (idle)" : sleepStatus === "hw_sleep" ? "😴 Hardware sleep" : "👋 Awake";
  lines.push(`  State: ${stateLabel}`);
  if (lock) {
    const counts = Object.values(lock.steps);
    const ok = counts.filter(s => s.status === "ok").length;
    const failed = counts.filter(s => s.status === "failed").length;
    const skipped = counts.filter(s => s.status === "skipped").length;
    lines.push(`  Last cycle: ${lock.date} — ${ok} ok, ${failed} failed, ${skipped} skipped (${lock.status}, ${lock.llmCalls} LLM calls)`);
  } else {
    lines.push("  Last cycle: (none found)");
  }
  lines.push(`  Schedule: BED_TIME=${bedTime}`);
  if (force) lines.push(`  Force-trigger: ${force}`);
  lines.push("");
  lines.push("/sleep resume — retry failed steps");
  lines.push("/sleep now — full fresh cycle");
  await ctx.reply(lines.join("\n"));
  return true;
}

export async function handleSleepSub(text: string, ctx: CommandContext): Promise<boolean> {
  const sub = text.replace(/^\/sleep\s+/i, "").trim().toLowerCase();
  const sleepStatus = readBridgeLockField<string>("sleepStatus") ?? "awake";

  if (sleepStatus === "sleeping") {
    await ctx.reply("😴 Sleep already running.");
    return true;
  }

  const auditDir = ctx.memoryConfig?.memoryDir ? join(ctx.memoryConfig.memoryDir, "sleep") : "";

  if (sub === "resume") {
    const lock = auditDir ? readLatestSleepLock(auditDir) : null;
    const hasIncomplete = lock && Object.values(lock.steps).some(s => s.status === "failed" || s.status === "pending");
    if (!lock || lock.status === "completed" || !hasIncomplete) {
      await ctx.reply("No failed sleep cycle to resume — use /sleep now for a fresh run.");
      return true;
    }
    writeForceSleep("resume via /sleep resume");
    await ctx.reply("Sleep resume queued");
    logInfo(TAG, "Sleep resume triggered via /sleep resume");
    return true;
  }

  if (sub === "now") {
    if (auditDir) {
      const lock = readLatestSleepLock(auditDir);
      if (!lock || lock.status === "completed") {
        try { unlinkSync(todayLockPath(auditDir)); } catch (err) { logAndSwallow("command_handlers", "op", err); }
      }
    }
    writeForceSleep("fresh via /sleep now");
    await ctx.reply("💤 Full sleep cycle initiated");
    logInfo(TAG, "Fresh sleep triggered via /sleep now");
    return true;
  }

  await ctx.reply("Unknown subcommand. Use /sleep, /sleep resume, or /sleep now.");
  return true;
}

export async function handleWakeup(_text: string, ctx: CommandContext): Promise<boolean> {
  if (readBridgeLockField("sleepStatus") !== "hw_sleep") {
    await ctx.reply("Already awake.");
    return true;
  }
  const os = platform();
  let child: ReturnType<typeof spawn> | null = null;
  if (os === "darwin") {
    child = spawn("caffeinate", ["-su"], { stdio: "ignore", detached: true });
  } else if (os === "linux") {
    child = spawn("systemd-inhibit", ["--what=idle:sleep", "sleep", "infinity"], { stdio: "ignore", detached: true });
  }
  if (child?.pid) {
    child.unref();
    setWakeInhibitPid(child.pid);
    writeSleepStatus("awake");
    const bedTime = getEnv().bedTime.raw;
    await ctx.reply(`☀️ Awake! Will sleep again at ${bedTime} or when requested.`);
    logInfo("wakeup", `Emergency wake — inhibit pid=${child.pid}`);
  } else {
    writeSleepStatus("awake");
    await ctx.reply("☀️ Awake! (sleep inhibitor not available on this platform)");
  }
  return true;
}

// ── /sleep — status + force-trigger ─────────────────────────────────────────

function readLatestSleepLock(auditDir: string): { date: string; status: string; llmCalls: number; steps: Record<string, { status: string }> } | null {
  try {
    const files = readdirSync(auditDir).filter(f => f.startsWith("sleep_") && f.endsWith(".lock")).sort();
    if (files.length === 0) return null;
    const latest = files[files.length - 1]!;
    const raw = JSON.parse(readFileSync(join(auditDir, latest), "utf-8"));
    const dateMatch = latest.match(/sleep_(\d{4})(\d{2})(\d{2})/);
    const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : "unknown";
    return { date, status: raw.status ?? "unknown", llmCalls: raw.llmCalls ?? 0, steps: raw.steps ?? {} };
  } catch (err) { logAndSwallow(TAG, "readLastSleepAudit", err); return null; }
}

function todayLockPath(auditDir: string): string {
  const d = new Date();
  const ds = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return join(auditDir, `sleep_${ds}.lock`);
}
