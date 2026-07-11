import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { logInfo } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { readBridgeLockField } from "../transport/bridge-lock-transport.js";
import { readEntry } from "../tasks/task-store.js";
import type { CommandContext } from "./types.js";

const TAG = "cmd";

/** Find the canonical schedule of the seeded sleep-cycle task entry (#1321). */
function readSleepSchedule(): string {
  try {
    const entry = readEntry("sleep-cycle");
    return entry?.schedule ?? "(not configured)";
  } catch (err) { logAndSwallow(TAG, "readSleepSchedule", err); return "(unknown)"; }
}

export async function handleSleep(_text: string, ctx: CommandContext): Promise<boolean> {
  const sleepStatus = readBridgeLockField<string>("sleepStatus") ?? "awake";
  const progress = ctx.sleepProgress?.();
  const auditDir = ctx.memoryConfig?.memoryDir ? join(ctx.memoryConfig.memoryDir, "sleep") : "";
  const lock = auditDir ? readLatestSleepLock(auditDir) : null;

  const lines: string[] = ["😴 Sleep status"];
  let stateLabel: string;
  if (progress) {
    stateLabel = `🧠 Sleep cycle running (${progress.step}, ${progress.percent}%)`;
  } else if (sleepStatus === "sleeping") {
    stateLabel = "💤 Dreaming";
    // Show progress from lock file
    if (lock && lock.status === "ongoing") {
      const steps = Object.entries(lock.steps);
      const done = steps.filter(([, s]) => s.status === "ok" || s.status === "skipped").length;
      const current = steps.find(([, s]) => s.status === "pending" || s.status === "ongoing");
      const startedAt = lock.startedAt ? new Date(lock.startedAt).toISOString().replace("T", " ").slice(0, 16) : "";
      if (startedAt) stateLabel += ` (since ${startedAt})`;
      if (current) stateLabel += `\n  Step: ${current[0]} (${done}/${steps.length})`;
    }
  } else {
    stateLabel = "👋 Awake";
  }
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
  lines.push(`  Schedule: ${readSleepSchedule()} (tasks.json sleep-cycle)`);
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
    // Validate there is an incomplete cycle to resume (#1321 req 21).
    const lock = auditDir ? readLatestSleepLock(auditDir) : null;
    const hasIncomplete = lock && Object.values(lock.steps).some(s => s.status === "failed" || s.status === "pending");
    if (!lock || lock.status === "completed" || !hasIncomplete) {
      await ctx.reply("No failed sleep cycle to resume — use /sleep now for a fresh run.");
      return true;
    }
    const r = ctx.startSleep?.({ fresh: false, resume: true });
    if (r === "accepted") {
      await ctx.reply("😴 Sleep resume started");
      logInfo(TAG, "Sleep resume started via /sleep resume");
    } else {
      await ctx.reply(`😴 Sleep resume not started (${r ?? "unavailable"})`);
    }
    return true;
  }

  if (sub === "now") {
    const r = ctx.startSleep?.({ fresh: true, resume: false });
    if (r === "accepted") {
      await ctx.reply("💤 Full sleep cycle started");
      logInfo(TAG, "Fresh sleep started via /sleep now");
    } else if (r === "already_running") {
      await ctx.reply("😴 Sleep already running.");
    } else {
      await ctx.reply(`😴 Sleep not started (${r ?? "unavailable"})`);
    }
    return true;
  }

  await ctx.reply("Unknown subcommand. Use /sleep, /sleep resume, or /sleep now.");
  return true;
}

// ── /sleep — status + manual start ──────────────────────────────────────────

function readLatestSleepLock(auditDir: string): { date: string; status: string; llmCalls: number; startedAt?: number; steps: Record<string, { status: string }> } | null {
  try {
    const files = readdirSync(auditDir).filter(f => f.startsWith("sleep_") && f.endsWith(".lock")).sort();
    if (files.length === 0) return null;
    const latest = files[files.length - 1]!;
    const raw = JSON.parse(readFileSync(join(auditDir, latest), "utf-8"));
    const dateMatch = latest.match(/sleep_(\d{4})(\d{2})(\d{2})/);
    const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : "unknown";
    return { date, status: raw.status ?? "unknown", llmCalls: raw.llmCalls ?? 0, startedAt: raw.startedAt, steps: raw.steps ?? {} };
  } catch (err) { logAndSwallow(TAG, "readLastSleepAudit", err); return null; }
}
