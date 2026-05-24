import { execAsync } from "./exec-async.js";
import { logError } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import type { CommandContext } from "./types.js";

const TAG = "cmd_tasks";


export async function handleTasksList(_text: string, ctx: CommandContext): Promise<boolean> {
  const tz = process.env["TZ"] || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date().toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "medium" });
  let listing: string;
  try {
    const { readEntries } = await import("../tasks/task-store.js");
    const entries = readEntries();
    const active = entries.filter((e: any) => !e.fired && !e.paused);
    active.sort((a: any, b: any) => {
      const timeOf = (e: any): number => {
        const s = e.schedule;
        if (!s) return e.fireAt ?? 0;
        const parts = s.split(" ");
        return (parseInt(parts[1] ?? "0", 10) * 60) + parseInt(parts[0] ?? "0", 10);
      };
      return timeOf(a) - timeOf(b);
    });
    const today = new Date();
    const dow = today.getDay();
    const lines = active.map((e: any) => {
      const sched = e.schedule ?? "one-shot";
      let runsToday = true;
      if (sched !== "one-shot") {
        const parts = sched.split(" ");
        const dowField = parts[4] ?? "*";
        if (dowField !== "*") {
          const allowed = new Set<number>();
          for (const seg of dowField.split(",")) {
            if (seg.includes("-")) {
              const [a, b] = seg.split("-").map(Number);
              for (let i = a; i <= b; i++) allowed.add(i);
            } else allowed.add(Number(seg));
          }
          runsToday = allowed.has(dow);
        }
      }
      const succeeded = e.history?.some((h: any) => h.exitCode === 0 && new Date(h.ts).toDateString() === today.toDateString());
      const failed = e.history?.some((h: any) => h.exitCode !== undefined && h.exitCode !== 0 && new Date(h.ts).toDateString() === today.toDateString());
      const started = e.lastRanAt && new Date(e.lastRanAt).toDateString() === today.toDateString();
      const running = ctx.cronCurrentJob?.entryId === e.id;
      const tick = !runsToday ? "—" : succeeded ? "✓" : running ? "~" : failed ? "✗" : started ? "✗" : "+";
      const label = e.title || e.message.split("\n")[0].replace(/[~\/][\w.\/-]+\//g, "").slice(0, 30);
      return `${tick}  ${e.id.padEnd(22)}${sched.padEnd(16)}${label}`;
    });
    listing = lines.length > 0 ? "<pre>" + lines.join("\n") + "</pre>" : "(no active entries)";
  } catch (err) {
    logError("tasks", `Failed to read cron: ${err instanceof Error ? err.message : String(err)}`);
    listing = "(no active entries)";
  }
  let running = "";
  if (ctx.cronCurrentJob) {
    const j = ctx.cronCurrentJob;
    const ago = Math.round((Date.now() - j.startedAt) / 1000);
    running = `\n▶ Running: ${j.type} (pid ${j.pid}, ${ago}s ago)\n   ${j.message}`;
  }
  await ctx.reply(`⏰ ${now}\n\n${listing}${running}`, { parseMode: "HTML" });
  return true;
}

export async function handleTasksTrigger(text: string, ctx: CommandContext): Promise<boolean> {
  const id = text.replace(/^\/(tasks?|cron) run /, "").trim();
  if (!id) { await ctx.reply("Usage: /task run <cron-id>"); return true; }
  const err = ctx.enqueueCron?.(id, true);
  await ctx.reply(err ?? `⏳ Running: ${id}`);
  return true;
}

export async function handleTasksLog(text: string, ctx: CommandContext): Promise<boolean> {
  const id = text.replace(/^\/(tasks?|cron) log /, "").trim();
  const placeholderId = await ctx.reply("📋 Loading task log...");
  try {
    const raw = await execAsync("abtars-task", ["history", id], 5000);
    if (!raw) throw new Error("empty");
    const data = JSON.parse(raw);
    if (!data.ok) {
      const msg = `❌ ${data.error}`;
      if (placeholderId !== undefined && ctx.editReply) await ctx.editReply(placeholderId, msg);
      else await ctx.reply(msg);
      return true;
    }
    const runs = (data.runs as { ranAt: string; exitCode?: number }[]).slice(-5);
    const lines = runs.map(r => `${r.ranAt}  exit=${r.exitCode ?? "?"}`);
    const body = `📋 ${data.message}\n\n\`\`\`\n${lines.join("\n") || "(no runs)"}\n\`\`\``;
    if (placeholderId !== undefined && ctx.editReply) await ctx.editReply(placeholderId, body);
    else await ctx.reply(body, { parseMode: "Markdown" });
  } catch (err) {
    logAndSwallow(TAG, "read task history", err);
    const msg = "❌ Failed to read history";
    if (placeholderId !== undefined && ctx.editReply) await ctx.editReply(placeholderId, msg);
    else await ctx.reply(msg);
  }
  return true;
}
