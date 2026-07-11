/**
 * abtars-task — schedule time-based reminders and tasks.
 *
 * Usage:
 *   abtars-task add --at "2026-03-16T08:00" --message "Remind about cookies" --chat-id 7773842843 --type reminder
 *   abtars-task list
 *   abtars-task remove <id>
 *
 * File: ~/.abtars/tasks/tasks.json
 */

import { localISO } from "../utils/local-time.js";
import { readEntries as dbReadEntries, readEntry, writeEntry, removeEntry as dbRemoveEntry } from "../components/tasks/task-store.js";
import { newTaskId, type CronEntry, type SystemTaskAction, SYSTEM_ACTIONS } from "../components/tasks/task-types.js";

// Re-export so any external import of `CronEntry` from the CLI still resolves.
// The canonical home is now src/components/tasks/task-types.ts (#1321).
export type { CronEntry } from "../components/tasks/task-types.js";

export function readEntries(): CronEntry[] {
  return dbReadEntries();
}

interface AddArgs {
  id?: string;
  at?: string;
  message?: string;
  chatId?: string;
  type?: string;
  executor?: string;
  action?: string;
  schedule?: string;
  title?: string;
  taskFile?: string;
  agent?: string;
  targetUserId?: string;
}

function parseAddArgs(args: string[]): AddArgs {
  const parsed: AddArgs = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--id": parsed.id = args[++i] ?? ""; break;
      case "--at": parsed.at = args[++i] ?? ""; break;
      case "--message": parsed.message = args[++i] ?? ""; break;
      case "--chat-id": parsed.chatId = args[++i] ?? ""; break;
      case "--type": parsed.type = args[++i] ?? ""; break;
      case "--executor": parsed.executor = args[++i] ?? ""; break;
      case "--action": parsed.action = args[++i] ?? ""; break;
      case "--schedule": parsed.schedule = args[++i] ?? ""; break;
      case "--title": parsed.title = args[++i] ?? ""; break;
      case "--task-file": parsed.taskFile = args[++i] ?? ""; break;
      case "--agent": parsed.agent = args[++i] ?? ""; break;
      case "--target-user": parsed.targetUserId = args[++i] ?? ""; break;
    }
  }
  return parsed;
}

import { CronExpressionParser } from "cron-parser";

function add(args: string[]): void {
  const parsed = parseAddArgs(args);
  if (!parsed.at && !parsed.schedule) { console.log(JSON.stringify({ ok: false, error: "--at or --schedule is required" })); process.exit(1); }
  if (parsed.at && parsed.schedule) { console.log(JSON.stringify({ ok: false, error: "use --at (one-shot) or --schedule (recurring), not both" })); process.exit(1); }
  if (!parsed.title) { console.log(JSON.stringify({ ok: false, error: "--title is required" })); process.exit(1); }

  let fireAt: number;
  let schedule: string | undefined;

  if (parsed.schedule) {
    try {
      const expr = CronExpressionParser.parse(parsed.schedule);
      fireAt = expr.next().getTime();
      schedule = parsed.schedule;
    } catch {
      console.log(JSON.stringify({ ok: false, error: "Invalid --schedule cron expression" })); process.exit(1);
    }
  } else {
    fireAt = new Date(parsed.at!).getTime();
    if (!Number.isFinite(fireAt)) { console.log(JSON.stringify({ ok: false, error: "Invalid --at date" })); process.exit(1); }
  }

  const type = (parsed.type ?? "reminder") as CronEntry["type"];
  if (type !== "reminder" && type !== "task") { console.log(JSON.stringify({ ok: false, error: "--type must be reminder or task" })); process.exit(1); }

  // #1321: system executor is an allowlisted in-process action.
  const executor = (parsed.executor ?? "agent") as NonNullable<CronEntry["executor"]>;
  const isSystem = executor === "system";
  if (executor !== "agent" && executor !== "script" && executor !== "orc" && !isSystem) {
    console.log(JSON.stringify({ ok: false, error: "--executor must be agent, script, orc, or system" })); process.exit(1);
  }

  let action: SystemTaskAction | undefined;
  if (isSystem) {
    if (!parsed.action) { console.log(JSON.stringify({ ok: false, error: "--action is required for system executor (allowlist: " + SYSTEM_ACTIONS.join(", ") + ")" })); process.exit(1); }
    if (!SYSTEM_ACTIONS.includes(parsed.action as SystemTaskAction)) {
      console.log(JSON.stringify({ ok: false, error: `--action must be one of: ${SYSTEM_ACTIONS.join(", ")}` })); process.exit(1);
    }
    action = parsed.action as SystemTaskAction;
  }

  // Non-system entries require message + chatId. System entries are allowlisted
  // bridge ops; chatId may be resolved to the main chat for notification metadata
  // but is not an argument to the action.
  let chatId = 0;
  if (!isSystem) {
    if (!parsed.message) { console.log(JSON.stringify({ ok: false, error: "--message is required" })); process.exit(1); }
    if (!parsed.chatId) { console.log(JSON.stringify({ ok: false, error: "--chat-id is required" })); process.exit(1); }
    chatId = parseInt(parsed.chatId, 10);
    if (!Number.isFinite(chatId)) { console.log(JSON.stringify({ ok: false, error: "Invalid --chat-id" })); process.exit(1); }
  } else if (parsed.chatId) {
    chatId = parseInt(parsed.chatId, 10);
  }

  const entry: CronEntry = {
    id: parsed.id || newTaskId(),
    title: parsed.title,
    fireAt: fireAt!,
    message: parsed.message ?? "",
    chatId,
    type,
    executor,
    ...(action ? { action } : {}),
    ...(schedule ? { schedule } : {}),
    ...(parsed.taskFile ? { taskFile: parsed.taskFile } : {}),
    ...(parsed.agent ? { agent: parsed.agent } : {}),
    ...(parsed.targetUserId ? { targetUserId: parsed.targetUserId } : {}),
    fired: false,
    createdAt: Date.now(),
  };

  const entries = dbReadEntries();

  // Dedup: recurring entries collide on executor+action/schedule. System tasks
  // dedup on action+schedule; others on message+schedule+chatId.
  if (schedule) {
    const dup = isSystem
      ? entries.find(e => e.executor === "system" && e.action === action && e.schedule === schedule && !e.paused)
      : entries.find(e => e.schedule === schedule && e.message === entry.message && e.chatId === chatId && !e.paused);
    if (dup) { console.log(JSON.stringify({ ok: false, error: "duplicate", existing_id: dup.id })); process.exit(1); }
  }

  writeEntry(entry);
  console.log(JSON.stringify({ ok: true, action: "added", id: entry.id, fireAt: localISO(new Date(fireAt!)), ...(schedule ? { schedule } : {}) }));
}

function listEntries(): void {
  const entries = readEntries().filter(e => !e.fired || e.schedule);
  if (entries.length === 0) {
    console.log(JSON.stringify({ ok: true, entries: [], message: "No pending cron entries" }));
    return;
  }
  const display = entries.map(e => ({
    id: e.id,
    fireAt: localISO(new Date(e.fireAt)),
    message: e.message,
    chatId: e.chatId,
    type: e.type,
    ...(e.executor ? { executor: e.executor } : {}),
    ...(e.schedule ? { schedule: e.schedule } : {}),
    ...(e.priority ? { priority: e.priority } : {}),
    ...(e.paused ? { paused: true } : {}),
    ...(e.lastRanAt ? { lastRanAt: localISO(new Date(e.lastRanAt)) } : {}),
    ...(e.history?.length ? { history: e.history } : {}),
  }));
  console.log(JSON.stringify({ ok: true, entries: display }));
}

function remove(id: string): void {
  if (!dbRemoveEntry(id)) { console.log(JSON.stringify({ ok: false, error: `Entry ${id} not found` })); process.exit(1); }
  console.log(JSON.stringify({ ok: true, action: "removed", id }));
}

function pause(id: string): void {
  const entry = readEntry(id);
  if (!entry) { console.log(JSON.stringify({ ok: false, error: `Entry ${id} not found` })); process.exit(1); }
  entry.paused = true;
  writeEntry(entry);
  console.log(JSON.stringify({ ok: true, action: "paused", id }));
}

function resume(id: string): void {
  const entry = readEntry(id);
  if (!entry) { console.log(JSON.stringify({ ok: false, error: `Entry ${id} not found` })); process.exit(1); }
  entry.paused = false;
  entry.consecutiveFails = 0;
  writeEntry(entry);
  console.log(JSON.stringify({ ok: true, action: "resumed", id }));
}

function showHistory(id: string): void {
  const entry = readEntry(id);
  if (!entry) { console.log(JSON.stringify({ ok: false, error: `Entry ${id} not found` })); process.exit(1); }
  const runs = (entry.history ?? []).map(h => ({
    ranAt: localISO(new Date(h.ts)),
    ...(h.exitCode !== undefined ? { exitCode: h.exitCode } : {}),
  }));
  console.log(JSON.stringify({ ok: true, id, message: entry.message.slice(0, 80), runs }));
}

// --- CLI entry point ---

export function main(argv: string[] = process.argv): void {
  if (argv.includes('--help')) {
    console.log(`abtars-task — schedule time-based reminders and tasks.

Usage:
  abtars-task add --at "2026-03-16T08:00" --message "..." --chat-id ID --type reminder
  abtars-task add --schedule "0 9 * * *" --message "..." --chat-id ID --type task
  abtars-task list
  abtars-task remove <id>
  abtars-task pause <id>
  abtars-task resume <id>
  abtars-task history <id>`);
    process.exit(0);
  }

  const args = argv.slice(2);
  const command = args[0];

  switch (command) {
    case "add":
      add(args.slice(1));
      break;
    case "list":
      listEntries();
      break;
    case "remove": {
      const id = args[1];
      if (!id) { console.log(JSON.stringify({ ok: false, error: "Usage: abtars-task remove <id>" })); process.exit(1); }
      remove(id);
      break;
    }
    case "pause": {
      const id = args[1];
      if (!id) { console.log(JSON.stringify({ ok: false, error: "Usage: abtars-task pause <id>" })); process.exit(1); }
      pause(id);
      break;
    }
    case "resume": {
      const id = args[1];
      if (!id) { console.log(JSON.stringify({ ok: false, error: "Usage: abtars-task resume <id>" })); process.exit(1); }
      resume(id);
      break;
    }
    case "history": {
      const id = args[1];
      if (!id) { console.log(JSON.stringify({ ok: false, error: "Usage: abtars-task history <id>" })); process.exit(1); }
      showHistory(id);
      break;
    }
    default:
      console.log(JSON.stringify({ ok: false, error: "Usage: abtars-task <add|list|remove|pause|resume|history> [args]" }));
      process.exit(1);
  }
}

const isDirectRun = process.argv[1]?.endsWith("abtars-task.ts") ||
  process.argv[1]?.endsWith("abtars-task.js");
if (isDirectRun) main();
