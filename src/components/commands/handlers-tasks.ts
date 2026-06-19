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
    const active = entries.filter((e: any) => !e.fired);
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
      const tick = e.paused ? "⏸" : !runsToday ? "—" : succeeded ? "✓" : running ? "~" : failed ? "✗" : started ? "✗" : "+";
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
    running = `\n▶ Running: ${j.type} (pid ${j.pid}, ${ago}s ago)\n   ${j.entryId}`;
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

export async function handleTaskPause(text: string, ctx: CommandContext): Promise<boolean> {
  const match = text.match(/^\/(tasks?|cron)\s+(pause|resume)\s+(.+)/i);
  if (!match) { await ctx.reply("Usage: /task pause|resume <id>"); return true; }
  const action = match[2]!.toLowerCase();
  const id = match[3]!.trim();
  try {
    const raw = await execAsync("abtars-task", [action, id], 5000);
    const data = JSON.parse(raw || "{}");
    await ctx.reply(data.ok ? `✓ ${id} ${action}d` : `❌ ${data.error ?? "unknown error"}`);
  } catch (err) {
    await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

export async function handleKanban(text: string, ctx: CommandContext): Promise<boolean> {
  try {
    const { kanbanList } = await import("../tasks/kanban-board.js");
    const arg = text.replace(/^\/kanban\s*/, "").trim();

    // Parse filter: "all", "status=done", "source=cron", "priority=HIGH", "labels=finance"
    const ALLOWED_FILTERS = new Set(["status", "source", "priority", "labels", "type"]);
    let filterVal: string | undefined;
    let filterKey: string | undefined;
    let showAll = false;

    if (arg === "all") {
      showAll = true;
    } else if (arg && arg.includes("=")) {
      const [key, val] = arg.split("=", 2);
      if (!key || !val || !ALLOWED_FILTERS.has(key)) {
        await ctx.reply(`❌ Invalid filter. Use: /kanban [all | status=X | source=X | priority=X | labels=X | type=X]`);
        return true;
      }
      filterKey = key;
      filterVal = val.replace(/[^a-zA-Z0-9_,-]/g, "").slice(0, 30);
    } else if (arg) {
      // Bare word = status filter
      filterVal = arg.replace(/[^a-zA-Z0-9_,-]/g, "").slice(0, 30);
    }

    const cards = showAll ? kanbanList("*") : kanbanList(filterVal, filterKey);
    if (cards.length === 0) {
      await ctx.reply("📋 Kanban board is empty.");
      return true;
    }
    const lines = cards.map((c: { id: number; title: string; status: string; source: string; priority: string; due_at: string | null; delivered_at: string | null }) => {
      const icon = c.status === "delivered" ? "✓" : c.status === "done" ? "+" : c.status === "running" ? "~" : c.status === "failed" ? "✗" : "-";
      const due = c.due_at ? ` due:${c.due_at.slice(0, 10)}` : "";
      const doneAt = c.delivered_at ? ` ${c.delivered_at.slice(2, 10).replace(/-/g, "")}:${c.delivered_at.slice(11, 16).replace(":", "")}` : "";
      const title = c.title.length > 20 ? c.title.slice(0, 17) + "…" : c.title;
      return `${icon} #${c.id} ${title} (${c.source}/${c.priority})${doneAt}${due}`;
    });
    const header = `📋 Kanban Board (${cards.length}):\n`;
    let body = "";
    for (const line of lines) {
      if (header.length + body.length + line.length + 1 > 3900) {
        body += `\n… +${cards.length - body.split("\n").length} more`;
        break;
      }
      body += (body ? "\n" : "") + line;
    }
    await ctx.reply(header + body);
  } catch (err) {
    await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

/** /channel command — master visibility into agent discussions (#891). */
export async function handleChannel(text: string, ctx: CommandContext): Promise<boolean> {
  const args = text.replace(/^\/channel\s*/i, "").trim();

  const { channelRead, channelPost } = await import("../tasks/kanban-channel.js");

  // /channel (no args) — list active channels
  if (!args) {
    const { kanbanList } = await import("../tasks/kanban-board.js");
    const active = kanbanList("running");
    if (active.length === 0) { await ctx.reply("No active channels."); return true; }
    const lines = active.map((c: any) => {
      const msgs = channelRead(c.id);
      return `#${c.id} "${c.title}" — ${msgs.length} msg${msgs.length !== 1 ? "s" : ""}`;
    });
    await ctx.reply(`📡 Active channels:\n${lines.join("\n")}`);
    return true;
  }

  // /channel <card_id> [message] or /channel <card_id> @Worker msg
  const match = args.match(/^(\d+)\s*(.*)?$/);
  if (!match) { await ctx.reply("Usage: /channel [card_id] [message]"); return true; }

  const cardId = parseInt(match[1]!, 10);
  const rest = (match[2] ?? "").trim();

  // /channel <card_id> — show discussion
  if (!rest) {
    const msgs = channelRead(cardId);
    if (msgs.length === 0) { await ctx.reply(`Channel #${cardId}: empty.`); return true; }
    const lines = msgs.map(m => {
      const remote = m.remote_peer ? `[${m.remote_peer}] ` : "";
      const type = m.msg_type && m.msg_type !== "progress" ? `[${m.msg_type}] ` : "";
      return `${remote}[${m.from_agent}→${m.to_agent}]${m.directive ? " ⚡" : ""} ${type}${m.message}`;
    });
    await ctx.reply(`📡 Channel #${cardId} (${msgs.length} msgs):\n${lines.join("\n")}`);
    return true;
  }

  // /channel <card_id> @Worker-01 msg — targeted post
  const atMatch = rest.match(/^@(\S+)\s+(.+)$/);
  const to = atMatch ? atMatch[1]! : "ALL";
  const message = atMatch ? atMatch[2]! : rest;
  channelPost(cardId, "master", to, message, true);
  await ctx.reply(`✓ Posted to card:${cardId} [master→${to}]`);
  return true;
}
