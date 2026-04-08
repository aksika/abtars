#!/usr/bin/env node
/**
 * agentbridge-task — schedule time-based reminders and tasks.
 *
 * Usage:
 *   agentbridge-task add --at "2026-03-16T08:00" --message "Remind about cookies" --chat-id 7773842843 --type reminder
 *   agentbridge-task list
 *   agentbridge-task remove <id>
 *
 * File: ~/.agentbridge/memory/cron.json
 */

import { localISO } from "../utils/local-time.js";
import { randomBytes } from "node:crypto";
import { readEntries as dbReadEntries, readEntry, writeEntry, removeEntry as dbRemoveEntry } from "../components/cron/cron-db.js";


export interface CronEntry {
  id: string;
  fireAt: number;
  message: string;
  chatId: number;
  type: "reminder" | "task";
  executor?: "agent" | "script";
  schedule?: string;
  priority?: "high" | "medium" | "low";
  taskFile?: string;
  paused?: boolean;
  fired: boolean;
  createdAt: number;
  lastRanAt?: number;
  retryAfter?: number;
  _prevFireAt?: number;
  _retrying?: boolean;
  history?: { ts: number; exitCode?: number }[];
}

export function readEntries(): CronEntry[] {
  return dbReadEntries();
}

interface AddArgs {
  at?: string;
  message?: string;
  chatId?: string;
  type?: string;
  executor?: string;
  schedule?: string;
}

function parseAddArgs(args: string[]): AddArgs {
  const parsed: AddArgs = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--at": parsed.at = args[++i] ?? ""; break;
      case "--message": parsed.message = args[++i] ?? ""; break;
      case "--chat-id": parsed.chatId = args[++i] ?? ""; break;
      case "--type": parsed.type = args[++i] ?? ""; break;
      case "--executor": parsed.executor = args[++i] ?? ""; break;
      case "--schedule": parsed.schedule = args[++i] ?? ""; break;
    }
  }
  return parsed;
}

import { CronExpressionParser } from "cron-parser";

function add(args: string[]): void {
  const parsed = parseAddArgs(args);
  if (!parsed.at && !parsed.schedule) { console.log(JSON.stringify({ ok: false, error: "--at or --schedule is required" })); process.exit(1); }
  if (parsed.at && parsed.schedule) { console.log(JSON.stringify({ ok: false, error: "use --at (one-shot) or --schedule (recurring), not both" })); process.exit(1); }
  if (!parsed.message) { console.log(JSON.stringify({ ok: false, error: "--message is required" })); process.exit(1); }
  if (!parsed.chatId) { console.log(JSON.stringify({ ok: false, error: "--chat-id is required" })); process.exit(1); }

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

  const chatId = parseInt(parsed.chatId, 10);
  if (!Number.isFinite(chatId)) { console.log(JSON.stringify({ ok: false, error: "Invalid --chat-id" })); process.exit(1); }

  const type = (parsed.type ?? "reminder") as CronEntry["type"];
  if (type !== "reminder" && type !== "task") { console.log(JSON.stringify({ ok: false, error: "--type must be reminder or task" })); process.exit(1); }

  const executor = (parsed.executor ?? "agent") as NonNullable<CronEntry["executor"]>;
  if (executor !== "agent" && executor !== "script") { console.log(JSON.stringify({ ok: false, error: "--executor must be agent or script" })); process.exit(1); }

  const entry: CronEntry = {
    id: randomBytes(3).toString("hex"),
    fireAt: fireAt!,
    message: parsed.message,
    chatId,
    type,
    executor,
    ...(schedule ? { schedule } : {}),
    fired: false,
    createdAt: Date.now(),
  };

  const entries = dbReadEntries();

  // Dedup: reject if a recurring entry with same schedule+message+chatId already exists
  if (schedule) {
    const dup = entries.find(e => e.schedule === schedule && e.message === entry.message && e.chatId === chatId && !e.paused);
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
    console.log(`agentbridge-task — schedule time-based reminders and tasks.

Usage:
  agentbridge-task add --at "2026-03-16T08:00" --message "..." --chat-id ID --type reminder
  agentbridge-task add --schedule "0 9 * * *" --message "..." --chat-id ID --type task
  agentbridge-task list
  agentbridge-task remove <id>
  agentbridge-task pause <id>
  agentbridge-task resume <id>
  agentbridge-task history <id>`);
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
      if (!id) { console.log(JSON.stringify({ ok: false, error: "Usage: agentbridge-task remove <id>" })); process.exit(1); }
      remove(id);
      break;
    }
    case "pause": {
      const id = args[1];
      if (!id) { console.log(JSON.stringify({ ok: false, error: "Usage: agentbridge-task pause <id>" })); process.exit(1); }
      pause(id);
      break;
    }
    case "resume": {
      const id = args[1];
      if (!id) { console.log(JSON.stringify({ ok: false, error: "Usage: agentbridge-task resume <id>" })); process.exit(1); }
      resume(id);
      break;
    }
    case "history": {
      const id = args[1];
      if (!id) { console.log(JSON.stringify({ ok: false, error: "Usage: agentbridge-task history <id>" })); process.exit(1); }
      showHistory(id);
      break;
    }
    default:
      console.log(JSON.stringify({ ok: false, error: "Usage: agentbridge-task <add|list|remove|pause|resume|history> [args]" }));
      process.exit(1);
  }
}

const isDirectRun = process.argv[1]?.endsWith("agentbridge-task.ts") ||
  process.argv[1]?.endsWith("agentbridge-task.js");
if (isDirectRun) main();
