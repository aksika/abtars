import { execAsync } from "./exec-async.js";
import { logError } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { formatTaskLabel } from "../tasks/task-types.js";
import type { CommandContext } from "./types.js";

const TAG = "cmd_tasks";


export async function handleTasksList(_text: string, ctx: CommandContext): Promise<boolean> {
  const tz = process.env["TZ"] || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date().toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "medium" });
  let listing: string;
  try {
    const { readEntries } = await import("../tasks/task-store.js");
    const { readState } = await import("../tasks/task-state-store.js");
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
      const state = readState(e.id);
      const autoPaused = state?.autoPaused ?? false;
      const defPaused = e.paused ?? false;
      const isPaused = autoPaused || defPaused;
      const succeeded = e.history?.some((h: any) => h.exitCode === 0 && new Date(h.ts).toDateString() === today.toDateString());
      const failed = e.history?.some((h: any) => h.exitCode !== undefined && h.exitCode !== 0 && new Date(h.ts).toDateString() === today.toDateString());
      const started = e.lastRanAt && new Date(e.lastRanAt).toDateString() === today.toDateString();
      const running = ctx.cronCurrentJob?.entryId === e.id;
      const activeRun = state?.activeRun;
      const isActive = activeRun && ["reserved", "queued", "executing", "cancelling", "validating", "settling"].includes(activeRun.phase);
      const tick = isPaused ? "p" : !runsToday ? "-" : succeeded ? "+" : running || isActive ? "~" : failed ? "x" : started ? "x" : "+";
      // #1520: show category/code plus failure count, latest occurrence, and
      // the exact resume command.
      let pauseMarker = "";
      if (autoPaused) {
        const inc = state?.lastIncident;
        const code = inc ? `${inc.category}/${inc.code}` : `${state?.consecutiveFailures ?? 0}f`;
        const at = state?.pausedAt ? ` @${new Date(state.pausedAt).toLocaleTimeString()}` : "";
        pauseMarker = ` [auto-paused:${code} · ${state?.consecutiveFailures ?? 0}f${at} — /task resume ${e.id}]`;
      } else if (isActive) {
        pauseMarker = ` [${activeRun.phase}]`;
      } else if (state?.retrying) {
        pauseMarker = " [retrying]";
      } else if (state?.deferredAdmission) {
        pauseMarker = ` [deferred:${state.deferredAdmission.attempts}/5 → ${new Date(state.deferredAdmission.retryAt).toLocaleTimeString()}]`;
      }
      return `${tick}  ${sched.padEnd(16)}${e.id}${pauseMarker}`;
    });
    listing = lines.length > 0 ? "<pre>" + lines.join("\n") + "</pre>" : "(no active entries)";
  } catch (err) {
    logError("tasks", `Failed to read cron: ${err instanceof Error ? err.message : String(err)}`);
    listing = "(no active entries)";
  }
  let running = "";
  // #1539: show every lane currently executing with its durable run identity.
  const jobs = ctx.cronCurrentJobs ?? (ctx.cronCurrentJob ? [ctx.cronCurrentJob] : []);
  const queueView = ctx.cronQueueView?.();
  const runViews = new Map((queueView ?? []).flatMap(l => l.current ? [[l.current.runId, l.current] as const] : []));
  if (jobs.length > 0) {
    const lines = jobs.map(j => {
      const ago = Math.round((Date.now() - j.startedAt) / 1000);
      const name = (j.message.split("\n")[0] ?? "").slice(0, 30);
      const view = runViews.get(j.runId);
      const phase = view?.phase ? ` phase=${view.phase}` : "";
      const deadline = view?.deadlineAt ? ` dl=${new Date(view.deadlineAt).toLocaleTimeString()}` : "";
      const card = view?.cardId !== undefined ? ` card=${view.cardId}` : "";
      const progress = view?.lastProgressAt !== undefined ? ` prog=${Math.max(0, Math.round((Date.now() - view.lastProgressAt) / 1000))}s` : "";
      const request = view?.terminalRequest ? ` req=${view.terminalRequest.kind}` : "";
      return `~ [${j.lane}] ${name} (${ago}s, run ${j.runId.slice(0, 16)}${phase}${progress}${deadline}${request}${card})`;
    });
    running = `\n${lines.join("\n")}`;
  }
  // #1539: durable pending state stays visible before a model session exists.
  if (queueView) {
    const pendingLines: string[] = [];
    for (const lane of queueView) {
      for (const p of lane.pending) {
        const run = p.runId ? `, run ${p.runId.slice(0, 16)}` : "";
        pendingLines.push(`  [${lane.lane}] queued: ${p.entryId}${run}`);
      }
    }
    if (pendingLines.length > 0) running += `\n${pendingLines.join("\n")}`;
  }
  await ctx.reply(`⏰ ${now}\n\n${listing}${running}`, { parseMode: "HTML" });
  return true;
}

export async function handleTasksTrigger(text: string, ctx: CommandContext): Promise<boolean> {
  const raw = text.replace(/^\/(tasks?|cron) run /, "").trim();
  if (!raw) { await ctx.reply("Usage: /task run <cron-id>"); return true; }

  // Resolve ID: try exact, then normalized (spaces→hyphens, lowercase)
  let id = raw;
  const { readEntry } = await import("../tasks/task-store.js");
  if (!readEntry(id)) {
    const normalized = raw.toLowerCase().replace(/\s+/g, "-");
    if (readEntry(normalized)) id = normalized;
  }

  const err = ctx.enqueueCron?.(id, true);
  if (err) { await ctx.reply(err); return true; }
  const name = formatTaskLabel(id);
  await ctx.reply(`Running task: ${name}`);
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
    const runs = (data.runs as { ranAt: string; exitCode?: number; diagnostic?: { category: string; code: string; message?: string } }[]).slice(-5);
    const lines = runs.map(r => {
      const diagnostic = r.diagnostic ? `  ${r.diagnostic.category}/${r.diagnostic.code}${r.diagnostic.message ? `: ${r.diagnostic.message}` : ""}` : "";
      return `${r.ranAt}  exit=${r.exitCode ?? "?"}${diagnostic}`;
    });
    const body = `📋 Task history: ${id}\n\n\`\`\`\n${lines.join("\n") || "(no runs)"}\n\`\`\``;
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
    if (action === "pause") {
      // #1609: one service operation for chat, CLI, and dashboard pause — it
      // refreshes pausedAt to now so an already-paused task gets a fresh
      // 12-hour cooldown.
      const { pauseTask } = await import("../tasks/task-service.js");
      const { readEntry } = await import("../tasks/task-store.js");
      const entry = readEntry(id);
      if (!entry) {
        await ctx.reply(`No task found for: ${id}`);
        return true;
      }
      pauseTask(id, [entry]);
      await ctx.reply(`Paused: ${id}`);
      return true;
    }
    // #1520: one service operation for chat and CLI resume.
    const { readEntry } = await import("../tasks/task-store.js");
    const { resumeAutoPaused } = await import("../tasks/task-service.js");
    const entry = readEntry(id);
    if (!entry) {
      await ctx.reply(`No task found for: ${id}`);
      return true;
    }
    const result = resumeAutoPaused(id, [entry]);
    switch (result) {
      case "resumed":
        await ctx.reply(`Resumed: ${id} — next run scheduled.`);
        break;
      case "not_paused":
        await ctx.reply(`${id} is not auto-paused.`);
        break;
      case "already_running":
        await ctx.reply(`${id} is currently running — cannot resume while active.`);
        break;
      case "invalid":
        await ctx.reply(`${id} definition is invalid — fix it before resuming.`);
        break;
      default:
        await ctx.reply(`No task found for: ${id}`);
    }
  } catch (err) {
    await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

/**
 * #1664: operator clear of a reconcile quarantine. Release the durable row,
 * then re-wake the card so it reconciles without waiting for an external event.
 */
export async function handleProjectUnquarantine(text: string, ctx: CommandContext): Promise<boolean> {
  const raw = text.replace(/^\/project unquarantine\s*/i, "").trim();
  const cardId = parseInt(raw, 10);
  if (!raw || !Number.isInteger(cardId) || cardId <= 0) {
    await ctx.reply("Usage: /project unquarantine <id>");
    return true;
  }
  try {
    const { ReconcileQuarantineStore } = await import("../reconcile-quarantine-store.js");
    const released = new ReconcileQuarantineStore().releaseQuarantine(cardId);
    if (!released) {
      await ctx.reply(`card ${cardId} is not quarantined`);
      return true;
    }
    const { requestReconcile } = await import("../reconciler.js");
    requestReconcile(cardId);
    await ctx.reply(`+ Quarantine cleared for card ${cardId} — reconciliation resumed.`);
  } catch (err) {
    await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

export async function handleKanban(text: string, ctx: CommandContext): Promise<boolean> {
  try {
    const { kanbanList, kanbanGetCard, kanbanSearch } = await import("../tasks/kanban-board.js");

    // Normalize curly quotes → straight (mobile keyboards autocorrect)
    const arg = text.replace(/^\/kanban\s*/i, "").trim()
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"');

    // /kanban — default list (active cards)
    if (!arg) {
      const cards = kanbanList();
      if (cards.length === 0) { await ctx.reply("Kanban board is empty."); return true; }
      await ctx.reply(renderList(cards));
      return true;
    }

    // /kanban all — everything
    if (arg === "all") {
      const cards = kanbanList("*");
      if (cards.length === 0) { await ctx.reply("Kanban board is empty."); return true; }
      await ctx.reply(renderList(cards));
      return true;
    }

    // /kanban <id> — full ticket detail
    if (/^\d+$/.test(arg)) {
      const card = kanbanGetCard(Number(arg));
      if (!card) { await ctx.reply(`No card #${arg}.`); return true; }
      await ctx.reply(renderDetail(card));
      return true;
    }

    // /kanban "<term>" — LIKE search (quotes mandatory)
    if (/^".*"$/.test(arg)) {
      const term = arg.slice(1, -1).trim();
      if (!term) { await ctx.reply(`Usage: /kanban "<search term>"`); return true; }
      const cards = kanbanSearch(term);
      if (cards.length === 0) { await ctx.reply(`No cards matching "${term}".`); return true; }
      await ctx.reply(renderList(cards));
      return true;
    }

    // Anything else — usage hint
    await ctx.reply(`Usage:\n  /kanban          — active cards\n  /kanban all      — all cards\n  /kanban <id>     — ticket detail\n  /kanban "<term>" — search`);
  } catch (err) {
    await ctx.reply(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

function renderList(cards: Awaited<ReturnType<typeof import("../tasks/kanban-board.js").kanbanList>>): string {
  const lines = cards.map(c => {
    const icon = c.status === "delivered" ? "✓" : c.status === "done" ? "+" : c.status === "running" ? "~" : c.status === "failed" ? "✗" : "-";
    const due = c.due_at ? ` due:${c.due_at.slice(0, 10)}` : "";
    const doneAt = c.delivered_at ? ` ${c.delivered_at.slice(2, 10).replace(/-/g, "")}:${c.delivered_at.slice(11, 16).replace(":", "")}` : "";
    const title = c.title.length > 20 ? c.title.slice(0, 17) + "…" : c.title;
    return `${icon} #${c.id} ${title} (${c.source}/${c.priority})${doneAt}${due}`;
  });
  const header = `Kanban Board (${cards.length}):\n`;
  let body = "";
  for (const line of lines) {
    if (header.length + body.length + line.length + 1 > 3900) {
      body += `\n… +${cards.length - body.split("\n").length} more`;
      break;
    }
    body += (body ? "\n" : "") + line;
  }
  return header + body;
}

function renderDetail(c: Awaited<ReturnType<typeof import("../tasks/kanban-board.js").kanbanGetCard>>): string {
  if (!c) return "(not found)";
  const icon = c.status === "delivered" ? "✓" : c.status === "done" ? "+" : c.status === "running" ? "~" : c.status === "failed" ? "✗" : "-";
  const lines = [
    `${icon} #${c.id}: ${c.title}`,
    `Status:   ${c.status}  |  Priority: ${c.priority}  |  Source: ${c.source}`,
  ];
  if (c.type) lines.push(`Type:     ${c.type}`);
  if (c.type === "O") {
    try {
      const { ProjectReviewStore, summarizeReviewCase } = require("../project-acceptance/project-review-store.js") as typeof import("../project-acceptance/project-review-store.js");
      const store = new ProjectReviewStore();
      const sup = store.getSupervision(c.id);
      if (sup) {
        lines.push(`Project:  ${sup.state}`);
        if (sup.generation) lines.push(` Gen:     ${sup.generation}`);
        if (sup.review_round || sup.repair_round) lines.push(` Round:   review=${sup.review_round} repair=${sup.repair_round}`);
        if (sup.blocked_reason) lines.push(` Blocked: ${sup.blocked_reason.slice(0, 100)}`);
        if (sup.accepted_decision_id) lines.push(` Accept:  ${sup.accepted_decision_id.slice(0, 16)}`);
        const reviewSummary = summarizeReviewCase(store.getLatestReviewCase(c.id));
        if (reviewSummary) lines.push(` Review: ${reviewSummary.trim()}`);
      }
    } catch {}
  }
  if (c.labels) lines.push(`Labels:   ${c.labels}`);
  if (c.assignee && c.assignee !== "professor") lines.push(`Assignee: ${c.assignee}`);
  if (c.due_at) lines.push(`Due:      ${c.due_at.slice(0, 10)}`);
  lines.push(`Created:  ${c.created_at.slice(0, 16)}`);
  if (c.completed_at) lines.push(`Completed:${c.completed_at.slice(0, 16)}`);
  if (c.delivered_at) lines.push(`Delivered:${c.delivered_at.slice(0, 16)}`);
  if (c.result_path) lines.push(`File:     ${c.result_path}`);
  if (c.result_summary) lines.push(`Result:   ${c.result_summary.slice(0, 300)}${c.result_summary.length > 300 ? "…" : ""}`);
  if (c.error) lines.push(`Error:    ${c.error.slice(0, 200)}`);
  if (c.notes) lines.push(`Notes:    ${c.notes.slice(0, 100)}`);
  return lines.join("\n");
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

export async function handleTodo(_text: string, ctx: CommandContext): Promise<boolean> {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { abtarsHome } = await import("../../paths.js");
  const todoPath = join(abtarsHome(), "workspace", "todo", "todo.md");
  if (!existsSync(todoPath)) { await ctx.reply("Todo list is empty."); return true; }
  const content = readFileSync(todoPath, "utf-8").trim();
  if (!content || content === "# Todo List") { await ctx.reply("Todo list is empty."); return true; }
  await ctx.reply(content);
  return true;
}
