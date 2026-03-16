#!/usr/bin/env node
/**
 * agentbridge-cron — schedule time-based reminders and tasks.
 *
 * Usage:
 *   agentbridge-cron add --at "2026-03-16T08:00" --message "Remind about cookies" --chat-id 7773842843 --type reminder
 *   agentbridge-cron list
 *   agentbridge-cron remove <id>
 *
 * File: ~/.agentbridge/memory/cron.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const cronPath = (): string => join(homedir(), ".agentbridge", "memory", "cron.json");

export interface CronEntry {
  id: string;
  fireAt: number;
  message: string;
  chatId: number;
  type: "reminder" | "task";
  fired: boolean;
  createdAt: number;
}

function ensureFile(): void {
  const dir = join(homedir(), ".agentbridge", "memory");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(cronPath())) writeFileSync(cronPath(), "[]", "utf-8");
}

export function readEntries(): CronEntry[] {
  ensureFile();
  try {
    return JSON.parse(readFileSync(cronPath(), "utf-8")) as CronEntry[];
  } catch {
    return [];
  }
}

function writeEntries(entries: CronEntry[]): void {
  writeFileSync(cronPath(), JSON.stringify(entries, null, 2), "utf-8");
}

interface AddArgs {
  at?: string;
  message?: string;
  chatId?: string;
  type?: string;
}

function parseAddArgs(args: string[]): AddArgs {
  const parsed: AddArgs = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--at": parsed.at = args[++i] ?? ""; break;
      case "--message": parsed.message = args[++i] ?? ""; break;
      case "--chat-id": parsed.chatId = args[++i] ?? ""; break;
      case "--type": parsed.type = args[++i] ?? ""; break;
    }
  }
  return parsed;
}

function add(args: string[]): void {
  const parsed = parseAddArgs(args);
  if (!parsed.at) { console.log(JSON.stringify({ ok: false, error: "--at is required" })); process.exit(1); }
  if (!parsed.message) { console.log(JSON.stringify({ ok: false, error: "--message is required" })); process.exit(1); }
  if (!parsed.chatId) { console.log(JSON.stringify({ ok: false, error: "--chat-id is required" })); process.exit(1); }

  const fireAt = new Date(parsed.at).getTime();
  if (!Number.isFinite(fireAt)) { console.log(JSON.stringify({ ok: false, error: "Invalid --at date" })); process.exit(1); }

  const chatId = parseInt(parsed.chatId, 10);
  if (!Number.isFinite(chatId)) { console.log(JSON.stringify({ ok: false, error: "Invalid --chat-id" })); process.exit(1); }

  const type = (parsed.type ?? "reminder") as CronEntry["type"];
  if (type !== "reminder" && type !== "task") { console.log(JSON.stringify({ ok: false, error: "--type must be reminder or task" })); process.exit(1); }

  const entry: CronEntry = {
    id: randomBytes(3).toString("hex"),
    fireAt,
    message: parsed.message,
    chatId,
    type,
    fired: false,
    createdAt: Date.now(),
  };

  const entries = readEntries();
  entries.push(entry);
  writeEntries(entries);
  console.log(JSON.stringify({ ok: true, action: "added", id: entry.id, fireAt: new Date(fireAt).toISOString() }));
}

function listEntries(): void {
  const entries = readEntries().filter(e => !e.fired);
  if (entries.length === 0) {
    console.log(JSON.stringify({ ok: true, entries: [], message: "No pending cron entries" }));
    return;
  }
  const display = entries.map(e => ({
    id: e.id,
    fireAt: new Date(e.fireAt).toISOString(),
    message: e.message,
    chatId: e.chatId,
    type: e.type,
  }));
  console.log(JSON.stringify({ ok: true, entries: display }));
}

function remove(id: string): void {
  const entries = readEntries();
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) { console.log(JSON.stringify({ ok: false, error: `Entry ${id} not found` })); process.exit(1); }
  entries.splice(idx, 1);
  writeEntries(entries);
  console.log(JSON.stringify({ ok: true, action: "removed", id }));
}

// --- CLI entry point ---

export function main(argv: string[] = process.argv): void {
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
      if (!id) { console.log(JSON.stringify({ ok: false, error: "Usage: agentbridge-cron remove <id>" })); process.exit(1); }
      remove(id);
      break;
    }
    default:
      console.log(JSON.stringify({ ok: false, error: "Usage: agentbridge-cron <add|list|remove> [args]" }));
      process.exit(1);
  }
}

const isDirectRun = process.argv[1]?.endsWith("agentbridge-cron.ts") ||
  process.argv[1]?.endsWith("agentbridge-cron.js");
if (isDirectRun) main();
