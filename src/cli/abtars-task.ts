import { localISO } from "../utils/local-time.js";
import { readEntries as dbReadEntries, writeEntry, removeEntry as dbRemoveEntry, readTaskCatalog, TaskCatalogUnavailableError } from "../components/tasks/task-store.js";
import { readState, updateState, removeState } from "../components/tasks/task-state-store.js";
import { requireTaskDatabase } from "../components/tasks/kanban-board.js";
import { recentRuns } from "../components/tasks/task-history-store.js";
import { validateTaskId, type ScheduledTask, type SystemTaskAction, SYSTEM_ACTIONS } from "../components/tasks/task-types.js";
import { validateTaskFile } from "../components/tasks/task-validator.js";

export function readEntries(): ScheduledTask[] {
  return dbReadEntries();
}

interface AddArgs {
  id?: string;
  at?: string;
  message?: string;
  chatId?: string;
  kind?: string;
  action?: string;
  schedule?: string;
  taskFile?: string;
  agent?: string;
}

function parseAddArgs(args: string[]): AddArgs {
  const parsed: AddArgs = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--id": parsed.id = args[++i] ?? ""; break;
      case "--at": parsed.at = args[++i] ?? ""; break;
      case "--message": parsed.message = args[++i] ?? ""; break;
      case "--chat-id": parsed.chatId = args[++i] ?? ""; break;
      case "--kind": parsed.kind = args[++i] ?? ""; break;
      case "--action": parsed.action = args[++i] ?? ""; break;
      case "--schedule": parsed.schedule = args[++i] ?? ""; break;
      case "--task-file": parsed.taskFile = args[++i] ?? ""; break;
      case "--agent": parsed.agent = args[++i] ?? ""; break;
    }
  }
  return parsed;
}

import { CronExpressionParser } from "cron-parser";

function add(args: string[]): void {
  const parsed = parseAddArgs(args);
  if (!parsed.at && !parsed.schedule) { console.log(JSON.stringify({ ok: false, error: "--at or --schedule is required" })); process.exit(1); }
  if (parsed.at && parsed.schedule) { console.log(JSON.stringify({ ok: false, error: "use --at (one-shot) or --schedule (recurring), not both" })); process.exit(1); }
  const idResult = validateTaskId(parsed.id ?? "", dbReadEntries());
  if (!idResult.ok) { console.log(JSON.stringify({ ok: false, error: idResult.error })); process.exit(1); }

  let schedule: string | undefined;
  let at: string | undefined;
  if (parsed.schedule) {
    try { CronExpressionParser.parse(parsed.schedule); } catch {
      console.log(JSON.stringify({ ok: false, error: "Invalid --schedule cron expression" })); process.exit(1);
    }
    schedule = parsed.schedule;
  } else {
    at = parsed.at;
    const ts = Date.parse(at ?? "");
    if (isNaN(ts)) { console.log(JSON.stringify({ ok: false, error: "Invalid --at date" })); process.exit(1); }
    at = new Date(ts).toISOString();
  }

  const kind = parsed.kind ?? "agent";
  const validKinds = ["reminder", "agent", "script", "system"];
  if (!validKinds.includes(kind)) { console.log(JSON.stringify({ ok: false, error: `--kind must be one of: ${validKinds.join(", ")}` })); process.exit(1); }

  const isSystem = kind === "system";
  let action: SystemTaskAction | undefined;
  if (isSystem) {
    if (!parsed.action) { console.log(JSON.stringify({ ok: false, error: "--action is required for system kind" })); process.exit(1); }
    if (!SYSTEM_ACTIONS.includes(parsed.action as SystemTaskAction)) {
      console.log(JSON.stringify({ ok: false, error: `--action must be one of: ${SYSTEM_ACTIONS.join(", ")}` })); process.exit(1);
    }
    action = parsed.action as SystemTaskAction;
  }

  const chatId = parsed.chatId ?? "0";

  let entry: ScheduledTask;
  const base = {
    id: idResult.id,
    enabled: true,
    priority: "medium" as const,
    chatId,
    delivery: isSystem ? "silent" as const : (kind === "reminder" ? "announce" as const : "announce" as const),
    schedule,
    at,
  };

  switch (kind) {
    case "reminder":
      entry = { ...base, kind: "reminder" as const, text: parsed.message ?? "", delivery: "announce" as const };
      break;
    case "agent":
      entry = { ...base, kind: "agent" as const, prompt: parsed.message, taskFile: parsed.taskFile, agent: (parsed.agent as "task" | "professor" | "browsie" | "coding" | "dreamy") || "task", interaction: { mode: "oneshot" }, orchestration: { maxAgents: 1 } };
      break;
    case "script":
      entry = { ...base, kind: "script" as const, command: parsed.message ?? "" };
      break;
    case "system":
      entry = { ...base, kind: "system" as const, action: action!, delivery: "silent" as const };
      break;
    default:
      console.log(JSON.stringify({ ok: false, error: `unknown kind ${kind}` })); process.exit(1);
  }

  const entries = dbReadEntries();
  if (entries.find(e => e.id === entry.id)) {
    console.log(JSON.stringify({ ok: false, error: "duplicate", existing_id: entry.id })); process.exit(1);
  }

  writeEntry(entry);
  const nextRunAt = schedule ? CronExpressionParser.parse(schedule).next().getTime() : (at ? Date.parse(at) : Date.now());
  updateState(entry.id, { nextRunAt });
  console.log(JSON.stringify({ ok: true, action: "added", id: entry.id, ...(schedule ? { schedule } : { at }) }));
}

function listEntries(): void {
  const catalog = readTaskCatalog();
  if (catalog.kind === "unavailable") {
    console.log(JSON.stringify({ ok: false, error: "task catalog unavailable", reason: catalog.reason }));
    process.exit(1);
  }
  const entries = readEntries();
  if (entries.length === 0) {
    console.log(JSON.stringify({ ok: true, entries: [], message: "No pending cron entries" }));
    return;
  }
  const display = entries.map(e => {
    const state = readState(e.id);
    return {
      id: e.id,
      kind: e.kind,
      enabled: e.enabled,
      ...(e.schedule ? { schedule: e.schedule } : {}),
      ...(e.priority ? { priority: e.priority } : {}),
      ...(state?.autoPaused ? { autoPaused: true } : {}),
      ...(state?.nextRunAt ? { nextRunAt: localISO(new Date(state.nextRunAt)) } : {}),
      // #1520: structured incident, pause time, counters, and resume command.
      ...(state?.lastIncident ? { lastIncident: state.lastIncident } : {}),
      ...(state?.pausedAt ? { pausedAt: localISO(new Date(state.pausedAt)) } : {}),
      ...(state ? {
        consecutiveFailures: state.consecutiveFailures ?? 0,
        consecutiveDeferrals: state.consecutiveDeferrals ?? 0,
        phase: state.activeRun?.phase ?? (state.deferredAdmission ? `deferred ${state.deferredAdmission.attempts}/5` : undefined),
        retryAt: state.retryAt ? localISO(new Date(state.retryAt)) : undefined,
        resume: state.autoPaused ? `abtars-task resume ${e.id}` : undefined,
      } : {}),
    };
  });
  console.log(JSON.stringify({ ok: true, entries: display }));
}

function remove(id: string): void {
  let removed: boolean;
  try {
    removed = dbRemoveEntry(id);
  } catch (err) {
    if (err instanceof TaskCatalogUnavailableError) {
      console.log(JSON.stringify({ ok: false, error: "task catalog unavailable", reason: err.reason }));
      process.exit(1);
    }
    throw err;
  }
  if (!removed) {
    const state = readState(id);
    if (state) {
      removeState(id);
      console.log(JSON.stringify({ ok: true, action: "removed", id }));
      return;
    }
    try {
      const db = requireTaskDatabase();
      const row = db.prepare("SELECT 1 FROM task_runs WHERE task_id = ? LIMIT 1").get(id) as Record<string, unknown> | undefined;
      if (row) {
        removeState(id);
        console.log(JSON.stringify({ ok: true, action: "removed", id }));
        return;
      }
    } catch { /* read failure = report not found */ }
    console.log(JSON.stringify({ ok: false, error: `Entry ${id} not found` })); process.exit(1);
  }
  removeState(id);
  console.log(JSON.stringify({ ok: true, action: "removed", id }));
}

function pause(id: string): void {
  const entries = dbReadEntries();
  const entry = entries.find(e => e.id === id);
  if (!entry) { console.log(JSON.stringify({ ok: false, error: `Entry ${id} not found` })); process.exit(1); }
  // #1609: one service operation for CLI, chat, and dashboard pause — it
  // refreshes pausedAt to now so an already-paused task gets a fresh
  // 12-hour cooldown.
  const { pauseTask } = require("../components/tasks/task-service.js") as typeof import("../components/tasks/task-service.js");
  pauseTask(id, entries);
  console.log(JSON.stringify({ ok: true, action: "paused", id }));
}

function resume(id: string): void {
  // #1520: one service operation for CLI and chat resume.
  const { resumeAutoPaused } = require("../components/tasks/task-service.js") as typeof import("../components/tasks/task-service.js");
  const entries = dbReadEntries();
  const entry = entries.find(e => e.id === id);
  if (!entry) { console.log(JSON.stringify({ ok: false, error: `Entry ${id} not found` })); process.exit(1); }
  const result = resumeAutoPaused(id, entries);
  switch (result) {
    case "resumed":
      console.log(JSON.stringify({ ok: true, action: "resumed", id }));
      break;
    case "not_paused":
      console.log(JSON.stringify({ ok: false, error: `Entry ${id} is not auto-paused` }));
      process.exit(1);
      break;
    case "already_running":
      console.log(JSON.stringify({ ok: false, error: `Entry ${id} is currently running` }));
      process.exit(1);
      break;
    case "invalid":
      console.log(JSON.stringify({ ok: false, error: `Entry ${id} definition is invalid` }));
      process.exit(1);
      break;
    default:
      console.log(JSON.stringify({ ok: false, error: `Entry ${id} not found` }));
      process.exit(1);
  }
}

function showHistory(id: string): void {
  const entry = dbReadEntries().find(e => e.id === id);
  if (!entry) { console.log(JSON.stringify({ ok: false, error: `Entry ${id} not found` })); process.exit(1); }
  const runs = recentRuns(id, 20).map(h => ({
    ranAt: localISO(new Date(h.finishedAt)),
    outcome: h.outcome,
    ...(h.exitCode !== undefined ? { exitCode: h.exitCode } : {}),
    // #1520: structured diagnostics on every unsuccessful run.
    ...(h.diagnostic ? { diagnostic: h.diagnostic } : {}),
  }));
  const label = entry.kind === "agent" ? (entry.prompt ?? entry.taskFile ?? "") : entry.kind === "script" ? entry.command : entry.kind;
  console.log(JSON.stringify({ ok: true, id, label: label.slice(0, 80), runs }));
}

function validate(path: string | undefined): void {
  const result = validateTaskFile(path);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
}

export function main(argv: string[] = process.argv): void {
  if (argv.includes('--help')) {
    console.log(`abtars-task — schedule time-based reminders and tasks.

Usage:
  abtars-task add --id <id> --schedule "0 9 * * *" --message "..." --chat-id ID
  abtars-task list
  abtars-task remove <id>
  abtars-task pause <id>
  abtars-task resume <id>
  abtars-task history <id>
  abtars-task validate [path]`);
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
    case "validate": {
      if (args.length > 2) {
        console.log(JSON.stringify({ ok: false, error: "Usage: abtars-task validate [path]" }));
        process.exit(1);
      }
      validate(args[1]);
      break;
    }
    default:
      console.log(JSON.stringify({ ok: false, error: "Usage: abtars-task <add|list|remove|pause|resume|history|validate> [args]" }));
      process.exit(1);
  }
}

const isDirectRun = process.argv[1]?.endsWith("abtars-task.ts") ||
  process.argv[1]?.endsWith("abtars-task.js");
if (isDirectRun) main();
