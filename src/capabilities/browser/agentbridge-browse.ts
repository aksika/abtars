#!/usr/bin/env node
/**
 * agentbridge-browse — spawn a browser subagent for autonomous web tasks.
 *
 * Usage:
 *   agentbridge-browse --task "check X notifications" --chat-id 7773842843
 *   agentbridge-browse --task "post on FB" --chat-id 123 --timeout 600
 *   agentbridge-browse --task "research topic" --chat-id 123 --dry-run
 *
 * Returns immediately. The subagent runs detached and results are delivered
 * via pending_reminders.json → bridge picks up → sends to chat.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { agentBridgeHome } from "../../paths.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { localDate } from "../../components/env-utils.js";

// --- Types ---

export interface BrowseArgs {
  task?: string;
  chatId?: string;
  threadId?: string;
  timeout?: string;
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
  const path = join(agentBridgeHome(), "prompts", "browsing_prompt.md");

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

const pendingPath = (): string => join(agentBridgeHome(), "memory", "pending_browse.json");

export function readPendingBrowse(): PendingBrowseEntry[] {
  const p = pendingPath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf-8")) as PendingBrowseEntry[]; }
  catch { return []; }
}

export function writePendingBrowse(entries: PendingBrowseEntry[]): void {
  const dir = join(agentBridgeHome(), "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(pendingPath(), JSON.stringify(entries, null, 2), "utf-8");
}

// --- Main ---

export function main(argv: string[] = process.argv): void {
  if (argv.includes('--help')) {
    console.log(`agentbridge-browse — spawn a browser subagent for autonomous web tasks.

Usage:
  agentbridge-browse --task "check X notifications" --chat-id ID
  agentbridge-browse --task "post on FB" --chat-id ID --timeout 600
  agentbridge-browse --task "research topic" --chat-id ID --dry-run`);
    process.exit(0);
  }

  loadDotenv({ path: join(agentBridgeHome(), ".env") });
  const raw = parseArgs(argv);
  const validation = validateArgs(raw);

  if (!validation.ok) {
    console.log(JSON.stringify({ ok: false, error: validation.error }));
    process.exit(1);
  }

  const { task, chatId, threadId, timeoutMs } = validation;

  // Dry-run: print prompt and exit
  if (raw.dryRun) {
    const prompt = loadBrowsePrompt(task, chatId);
    process.stdout.write(prompt + "\n");
    return;
  }

  const taskId = randomBytes(3).toString("hex");
  const logsDir = join(agentBridgeHome(), "logs");
  const subagentsDir = join(agentBridgeHome(), "subagents");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(subagentsDir, { recursive: true });
  const logFile = join(logsDir, `browse_${taskId}.log`);

  // Build prompt
  const prompt = loadBrowsePrompt(task, chatId, taskId);

  const browseModel = process.env.AGENT_BROWSE_MODEL || "claude-sonnet-4.5";

  // Spawn detached kiro-cli acp subprocess
  const promptFile = join(logsDir, `browse_${taskId}_prompt.txt`);
  writeFileSync(promptFile, prompt, "utf-8");

  // Spawn a detached wrapper that handles the full ACP lifecycle.
  // The wrapper does: initialize → newSession → prompt → wait for completion → exit.
  // This avoids broken pipe from parent exit.
  const wrapperScript = `
const { spawn } = require("child_process");
const { createInterface } = require("readline");
const { appendFileSync } = require("fs");
const logFile = process.argv[2];
const promptFile = process.argv[3];
const prompt = require("fs").readFileSync(promptFile, "utf-8");
const child = spawn("kiro-cli", ["acp", "--agent", "professor", "--model", ${JSON.stringify(browseModel)}], { stdio: ["pipe", "pipe", "pipe"] });
child.stdout.on("data", c => { try { appendFileSync(logFile, c); } catch {} });
child.stderr.on("data", c => { try { appendFileSync(logFile, c); } catch {} });
const rl = createInterface({ input: child.stdout });
let reqId = 0;
const send = msg => child.stdin.write(JSON.stringify(msg) + "\\n");
const waitRes = (id, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout")), ms);
  const h = line => { try { const p = JSON.parse(line); if (p.id === id) { clearTimeout(t); rl.off("line", h); p.error ? reject(new Error(p.error.message)) : resolve(p.result); } } catch {} };
  rl.on("line", h);
});
(async () => {
  try {
    send({ jsonrpc: "2.0", id: ++reqId, method: "initialize", params: { protocolVersion: "2025-03-26", clientCapabilities: {}, clientInfo: { name: "agentbridge-browse", version: "1.0.0" } } });
    await waitRes(reqId, 60000);
    send({ jsonrpc: "2.0", id: ++reqId, method: "session/new", params: { cwd: ${JSON.stringify(homedir())}, mcpServers: [] } });
    const sess = await waitRes(reqId, 60000);
    if (!sess.sessionId) throw new Error("no sessionId");
    send({ jsonrpc: "2.0", id: ++reqId, method: "session/prompt", params: { sessionId: sess.sessionId, prompt: [{ type: "text", text: prompt }] } });
    await waitRes(reqId, 600000);
  } catch (e) { appendFileSync(logFile, "\\nACP_ERROR: " + e + "\\n"); }
  child.kill(); process.exit();
})();
child.on("exit", () => process.exit());
`;
  const wrapperFile = join(logsDir, `browse_${taskId}_wrapper.cjs`);
  writeFileSync(wrapperFile, wrapperScript);

  const logFd = openSync(logFile, "w");
  closeSync(logFd); // just create the file

  const child = spawn("node", [wrapperFile, logFile, promptFile], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  // Record in pending_browse.json
  const entries = readPendingBrowse();
  entries.push({ taskId, task, chatId, threadId, pid: child.pid!, startedAt: Date.now(), timeoutMs, logFile });
  writePendingBrowse(entries);

  console.log(JSON.stringify({ ok: true, taskId, status: "spawned", pid: child.pid }));
}

const isDirectRun = process.argv[1]?.endsWith("agentbridge-browse.ts") ||
  process.argv[1]?.endsWith("agentbridge-browse.js");
if (isDirectRun) main();
