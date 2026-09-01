import { logInfo } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { readBridgeLockField } from "../transport/bridge-lock-transport.js";
import { readEntry } from "../tasks/task-store.js";
import { localDateTime } from "../../utils/local-time.js";
import type { SleepStatusLike, SleepStatusLastLike } from "../abmind-client-contract.js";
import type { CommandContext } from "./types.js";

const TAG = "cmd";

/** Find the canonical schedule of the seeded sleep-cycle task entry (#1321). */
function readSleepSchedule(): string {
  try {
    const entry = readEntry("sleep-cycle");
    return entry?.schedule ?? "(not configured)";
  } catch (err) { logAndSwallow(TAG, "readSleepSchedule", err); return "(unknown)"; }
}

async function readDaemonSleepStatus(ctx: CommandContext): Promise<SleepStatusLike | null> {
  if (ctx.memoryRuntime.state !== "ready") return null;
  try {
    return await ctx.memoryRuntime.getSleepStatus();
  } catch (err) {
    logAndSwallow(TAG, "readSleepStatus", err);
    return null;
  }
}

function formatLastCycle(status: SleepStatusLike | null): string {
  const last: SleepStatusLastLike | undefined = status?.last;
  if (!status) return "(daemon unavailable)";
  if (!last) return "(none recorded)";

  const timestamp = last.finishedAt ?? last.attemptedAt;
  const when = Number.isFinite(timestamp) ? localDateTime(new Date(timestamp)) : "unknown time";
  const resumable = last.resumable ? "; resumable" : "";
  const base = `${when} — ${last.status} (${last.completedSteps} completed, ${last.failedSteps} failed${resumable})`;
  if (last.report) {
    const capped = last.report.length > 800 ? `${last.report.slice(0, 800)}…` : last.report;
    return `${base}\n${capped}`;
  }
  return base;
}

export async function handleSleep(_text: string, ctx: CommandContext): Promise<boolean> {
  const sleepStatus = readBridgeLockField<string>("sleepStatus") ?? "awake";
  const progress = ctx.sleepProgress?.();
  const daemonStatus = await readDaemonSleepStatus(ctx);

  const lines: string[] = ["😴 Sleep status"];
  let stateLabel: string;
  if (progress) {
    stateLabel = `🧠 Sleep cycle running (${progress.step}, ${progress.percent}%)`;
  } else if (sleepStatus === "sleeping") {
    stateLabel = "💤 Dreaming";
  } else {
    stateLabel = "👋 Awake";
  }
  lines.push(`  State: ${stateLabel}`);
  lines.push(`  Last cycle: ${formatLastCycle(daemonStatus)}`);
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

  if (sub === "resume") {
    const r = ctx.startSleep?.({ fresh: false, resume: true }) as unknown as { status: string; admission?: Promise<{ status: string; runId?: string; reason?: string; code?: string }>; reason?: string } | undefined;
    if (!r) {
      await ctx.reply("😴 Sleep unavailable: sleep did not initialize during boot.");
      return true;
    }
    if (r.status === "accepted" && r.admission) {
      const admission = await r.admission as { status: string; runId?: string; reason?: string; code?: string };
      if (admission.status === "accepted") {
        await ctx.reply(`😴 Sleep resume started (run ${admission.runId})`);
        logInfo(TAG, `Sleep resume started via /sleep resume (run ${admission.runId})`);
      } else {
        await ctx.reply(`😴 Sleep resume rejected: ${admission.reason ?? admission.code ?? "unknown"} (${admission.code ?? "unknown"})`);
        logInfo(TAG, `Sleep resume rejected via /sleep resume: ${admission.code} ${admission.reason}`);
      }
    } else if (r.status === "already_running") {
      await ctx.reply("😴 Sleep already running.");
    } else if (r.status === "accepted") {
      // Fallback for callers without admission (tests)
      await ctx.reply("😴 Sleep resume started");
      logInfo(TAG, "Sleep resume started via /sleep resume");
    } else {
      await ctx.reply(`😴 Sleep unavailable: ${(r as { reason?: string }).reason}.`);
    }
    return true;
  }

  if (sub === "now") {
    const r = ctx.startSleep?.({ fresh: true, resume: false }) as unknown as { status: string; admission?: Promise<{ status: string; runId?: string; reason?: string; code?: string }>; reason?: string } | undefined;
    if (!r) {
      await ctx.reply("😴 Sleep unavailable: sleep did not initialize during boot.");
      return true;
    }
    if (r.status === "accepted" && r.admission) {
      const admission = await r.admission as { status: string; runId?: string; reason?: string; code?: string };
      if (admission.status === "accepted") {
        await ctx.reply(`💤 Full sleep cycle started (run ${admission.runId})`);
        logInfo(TAG, `Fresh sleep started via /sleep now (run ${admission.runId})`);
      } else {
        await ctx.reply(`😴 Sleep start rejected: ${admission.reason ?? admission.code ?? "unknown"} (${admission.code ?? "unknown"})`);
        logInfo(TAG, `Sleep start rejected via /sleep now: ${admission.code} ${admission.reason}`);
      }
    } else if (r.status === "already_running") {
      await ctx.reply("😴 Sleep already running.");
    } else if (r.status === "accepted") {
      await ctx.reply("💤 Full sleep cycle started");
      logInfo(TAG, "Fresh sleep started via /sleep now");
    } else {
      await ctx.reply(`😴 Sleep unavailable: ${(r as { reason?: string }).reason}.`);
    }
    return true;
  }

  await ctx.reply("Unknown subcommand. Use /sleep, /sleep resume, or /sleep now.");
  return true;
}
