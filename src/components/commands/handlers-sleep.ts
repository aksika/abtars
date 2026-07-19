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
  lines.push("  Last cycle: owner-side sleep status is available through the daemon");
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
    const r = ctx.startSleep?.({ fresh: false, resume: true });
    if (!r) {
      await ctx.reply("😴 Sleep unavailable: sleep did not initialize during boot.");
      return true;
    }
    if (r.status === "accepted") {
      await ctx.reply("😴 Sleep resume started");
      logInfo(TAG, "Sleep resume started via /sleep resume");
    } else if (r.status === "already_running") {
      await ctx.reply("😴 Sleep already running.");
    } else {
      await ctx.reply(`😴 Sleep unavailable: ${r.reason}.`);
    }
    return true;
  }

  if (sub === "now") {
    const r = ctx.startSleep?.({ fresh: true, resume: false });
    if (!r) {
      await ctx.reply("😴 Sleep unavailable: sleep did not initialize during boot.");
      return true;
    }
    if (r.status === "accepted") {
      await ctx.reply("💤 Full sleep cycle started");
      logInfo(TAG, "Fresh sleep started via /sleep now");
    } else if (r.status === "already_running") {
      await ctx.reply("😴 Sleep already running.");
    } else {
      await ctx.reply(`😴 Sleep unavailable: ${r.reason}.`);
    }
    return true;
  }

  await ctx.reply("Unknown subcommand. Use /sleep, /sleep resume, or /sleep now.");
  return true;
}
