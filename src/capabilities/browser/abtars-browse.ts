#!/usr/bin/env node
/**
 * abtars-browse — spawn a browser subagent for autonomous web tasks.
 *
 * Usage:
 *   abtars-browse --task "check X notifications" --chat-id 7773842843
 *   abtars-browse --task "post on FB" --chat-id 123 --timeout 600
 *   abtars-browse --task "research topic" --chat-id 123 --dry-run
 *
 * Returns immediately. The subagent runs detached and results are delivered
 * via pending_reminders.json → bridge picks up → sends to chat.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";

const TAG = "browse";
import { randomBytes } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { localDate } from "../../utils/date.js";

// --- Types ---

export interface BrowseArgs {
  task?: string;
  chatId?: string;
  threadId?: string;
  timeout?: string;
  engine?: string;
  dryRun: boolean;
}

export interface PendingBrowseEntry {
  taskId: string;
  task: string;
  chatId: number;
  threadId?: number;
  pid: number;
  startedAt: number;
  timeoutMs: number;
  logFile: string;
}

// --- Arg parsing ---

export function parseArgs(argv: string[]): BrowseArgs {
  const args = argv.slice(2);
  const parsed: BrowseArgs = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--task": parsed.task = args[++i] ?? ""; break;
      case "--chat-id": parsed.chatId = args[++i] ?? ""; break;
      case "--thread-id": parsed.threadId = args[++i] ?? ""; break;
      case "--timeout": parsed.timeout = args[++i] ?? ""; break;
      case "--engine": parsed.engine = args[++i] ?? ""; break;
      case "--dry-run": parsed.dryRun = true; break;
    }
  }
  return parsed;
}

export function validateArgs(args: BrowseArgs): { ok: true; task: string; chatId: number; threadId?: number; timeoutMs: number } | { ok: false; error: string } {
  if (!args.task) return { ok: false, error: "--task is required" };
  if (!args.chatId) return { ok: false, error: "--chat-id is required" };
  const chatId = parseInt(args.chatId, 10);
  if (!Number.isFinite(chatId)) return { ok: false, error: "invalid --chat-id" };
  const threadId = args.threadId ? parseInt(args.threadId, 10) : undefined;
  const timeoutMs = args.timeout ? parseInt(args.timeout, 10) * 1000 : 5 * 60 * 1000;
  if (!Number.isFinite(timeoutMs)) return { ok: false, error: "invalid --timeout" };
  const task = args.task.length > 2000 ? args.task.slice(0, 2000) + "…" : args.task;
  return { ok: true, task, chatId, threadId, timeoutMs };
}

// --- Prompt loading ---

export function loadBrowsePrompt(task: string, _chatId: number, taskId?: string): string {
  const path = join(abtarsHome(), "prompts", "browsing_prompt.md");

  if (!existsSync(path)) {
    throw new Error(`browsing_prompt.md not found at ${path}`);
  }
  const template = readFileSync(path, "utf-8");

  const date = localDate();
  const reportFile = `browse_${taskId ?? "unknown"}_${date}.md`;

  const vars: Record<string, string> = {
    TASK: task,
    TASK_ID: taskId ?? "unknown",
    DATE: date,
    REPORT_FILE: reportFile,
  };

  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`\${${key}}`, value);
  }
  return result;
}

// --- Pending browse file ---

const pendingPath = (): string => join(abtarsHome(), "memory", "pending_browse.json");

export function readPendingBrowse(): PendingBrowseEntry[] {
  const p = pendingPath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf-8")) as PendingBrowseEntry[]; }
  catch (err) { logAndSwallow(TAG, "readPendingBrowse", err); return []; }
}

export function writePendingBrowse(entries: PendingBrowseEntry[]): void {
  const dir = join(abtarsHome(), "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(pendingPath(), JSON.stringify(entries, null, 2), "utf-8");
}

// --- Main ---

export async function main(argv: string[] = process.argv): Promise<void> {
  if (argv.includes("--help")) {
    console.log(`abtars-browse — delegate a browser task to the Browsie agent.

Usage:
  abtars-browse --task "check X notifications" --chat-id ID
  abtars-browse --task "research topic" --chat-id ID --timeout 600
  abtars-browse --task "research topic" --chat-id ID --dry-run`);
    process.exit(0);
  }

  loadDotenv({ path: join(abtarsHome(), ".env") });
  const raw = parseArgs(argv);
  const validation = validateArgs(raw);

  if (!validation.ok) {
    console.log(JSON.stringify({ ok: false, error: validation.error }));
    process.exit(1);
  }

  const { task, chatId, threadId, timeoutMs } = validation;
  const taskId = randomBytes(3).toString("hex");

  // Dry-run: print prompt and exit
  if (raw.dryRun) {
    const prompt = loadBrowsePrompt(task, chatId, taskId);
    process.stdout.write(prompt + "\n");
    return;
  }

  mkdirSync(join(abtarsHome(), "subagents"), { recursive: true });

  const prompt = loadBrowsePrompt(task, chatId, taskId);

  // Send spawn request to bridge via IPC
  const spawnSocket = join(abtarsHome(), "browse-spawn.sock");
  const net = await import("node:net");
  const result = await new Promise<{ ok: boolean; taskId?: string; error?: string }>((resolve, reject) => {
    const conn = net.createConnection(spawnSocket);
    conn.on("connect", () => {
      conn.write(JSON.stringify({ taskId, task, prompt, chatId, threadId, timeoutMs }) + "\n");
    });
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      conn.end();
      try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
    });
    conn.on("error", reject);
    conn.setTimeout(10_000, () => { conn.destroy(); reject(new Error("IPC timeout")); });
  });

  console.log(JSON.stringify(result));
}

const isDirectRun = process.argv[1]?.endsWith("abtars-browse.ts") ||
  process.argv[1]?.endsWith("abtars-browse.js");
if (isDirectRun) main();
