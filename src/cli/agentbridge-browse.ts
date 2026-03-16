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
import { spawn, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

// --- Types ---

export interface BrowseArgs {
  task?: string;
  chatId?: string;
  timeout?: string;
  dryRun: boolean;
}

export interface PendingBrowseEntry {
  taskId: string;
  task: string;
  chatId: number;
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
      case "--timeout": parsed.timeout = args[++i] ?? ""; break;
      case "--dry-run": parsed.dryRun = true; break;
    }
  }
  return parsed;
}

export function validateArgs(args: BrowseArgs): { ok: true; task: string; chatId: number; timeoutMs: number } | { ok: false; error: string } {
  if (!args.task) return { ok: false, error: "--task is required" };
  if (!args.chatId) return { ok: false, error: "--chat-id is required" };
  const chatId = parseInt(args.chatId, 10);
  if (!Number.isFinite(chatId)) return { ok: false, error: "invalid --chat-id" };
  const timeoutMs = args.timeout ? parseInt(args.timeout, 10) * 1000 : 5 * 60 * 1000;
  if (!Number.isFinite(timeoutMs)) return { ok: false, error: "invalid --timeout" };
  const task = args.task.length > 2000 ? args.task.slice(0, 2000) + "…" : args.task;
  return { ok: true, task, chatId, timeoutMs };
}

// --- Prompt loading ---

export function loadBrowsePrompt(task: string, chatId: number): string {
  const deployed = join(homedir(), ".agentbridge", "browsing_prompt.md");
  const dev = join(process.cwd(), "persona", "browsing_prompt.md");

  let template: string;
  if (existsSync(deployed)) {
    template = readFileSync(deployed, "utf-8");
  } else if (existsSync(dev)) {
    template = readFileSync(dev, "utf-8");
  } else {
    throw new Error(`browsing_prompt.md not found at ${deployed} or ${dev}`);
  }

  // Check browser container status
  let browserStatus = "unknown";
  try {
    const out = execSync('docker ps --filter name=agentbridge-browser --format "{{.Status}}"', { timeout: 5000 }).toString().trim();
    browserStatus = out || "not running";
  } catch { browserStatus = "not running (docker check failed)"; }

  const vars: Record<string, string> = {
    TASK: task,
    CHAT_ID: String(chatId),
    TIMESTAMP: new Date().toISOString(),
    BROWSER_STATUS: browserStatus,
  };

  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`\${${key}}`, value);
  }
  return result;
}

// --- Pending browse file ---

const pendingPath = (): string => join(homedir(), ".agentbridge", "memory", "pending_browse.json");

export function readPendingBrowse(): PendingBrowseEntry[] {
  const p = pendingPath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf-8")) as PendingBrowseEntry[]; }
  catch { return []; }
}

export function writePendingBrowse(entries: PendingBrowseEntry[]): void {
  const dir = join(homedir(), ".agentbridge", "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(pendingPath(), JSON.stringify(entries, null, 2), "utf-8");
}

// --- Main ---

export async function main(argv: string[] = process.argv): Promise<void> {
  const raw = parseArgs(argv);
  const validation = validateArgs(raw);

  if (!validation.ok) {
    console.log(JSON.stringify({ ok: false, error: validation.error }));
    process.exit(1);
  }

  const { task, chatId, timeoutMs } = validation;

  // Dry-run: print prompt and exit
  if (raw.dryRun) {
    const prompt = loadBrowsePrompt(task, chatId);
    process.stdout.write(prompt + "\n");
    return;
  }

  const taskId = randomBytes(3).toString("hex");
  const logsDir = join(homedir(), ".agentbridge", "logs");
  mkdirSync(logsDir, { recursive: true });
  const logFile = join(logsDir, `browse_${taskId}.log`);

  // Build prompt
  const prompt = loadBrowsePrompt(task, chatId);

  // Spawn detached kiro-cli acp subprocess
  const promptFile = join(logsDir, `browse_${taskId}_prompt.txt`);
  writeFileSync(promptFile, prompt, "utf-8");

  const logFd = openSync(logFile, "w");
  const child = spawn("kiro-cli", ["acp", "--agent", "professor"], {
    stdio: ["pipe", "pipe", logFd],
    detached: true,
  });

  // Pipe stdout to log file
  child.stdout?.on("data", (chunk: Buffer) => {
    const fd = openSync(logFile, "a");
    writeFileSync(fd, chunk);
    closeSync(fd);
  });

  // ACP JSON-RPC handshake
  const rl = createInterface({ input: child.stdout! });
  let reqId = 0;
  const send = (msg: object) => child.stdin?.write(JSON.stringify(msg) + "\n");

  const waitResponse = (id: number): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ACP response timeout")), 30_000);
      const handler = (line: string) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            clearTimeout(timeout);
            rl.off("line", handler);
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed.result);
          }
        } catch { /* skip non-JSON */ }
      };
      rl.on("line", handler);
    });

  try {
    // 1. Initialize
    send({ jsonrpc: "2.0", id: ++reqId, method: "initialize", params: {
      protocolVersion: "2025-03-26", clientCapabilities: {},
      clientInfo: { name: "agentbridge-browse", version: "1.0.0" },
    }});
    await waitResponse(reqId);

    // 2. New session
    send({ jsonrpc: "2.0", id: ++reqId, method: "session/new", params: {
      cwd: homedir(), mcpServers: [],
    }});
    const sessionResult = await waitResponse(reqId) as { sessionId?: string };
    const sessionId = sessionResult.sessionId;
    if (!sessionId) throw new Error("No sessionId in session/new response");

    // 3. Send prompt — fire and forget, child runs detached
    send({ jsonrpc: "2.0", id: ++reqId, method: "session/prompt", params: {
      sessionId, prompt: [{ type: "text", text: prompt }],
    }});
  } catch (err) {
    const fd = openSync(logFile, "a");
    writeFileSync(fd, `\nACP_HANDSHAKE_ERROR: ${err}\n`);
    closeSync(fd);
  }

  // Detach — child continues processing the prompt
  rl.close();
  child.unref();
  closeSync(logFd);

  // Record in pending_browse.json
  const entries = readPendingBrowse();
  entries.push({ taskId, task, chatId, pid: child.pid!, startedAt: Date.now(), timeoutMs, logFile });
  writePendingBrowse(entries);

  console.log(JSON.stringify({ ok: true, taskId, status: "spawned", pid: child.pid }));
}

const isDirectRun = process.argv[1]?.endsWith("agentbridge-browse.ts") ||
  process.argv[1]?.endsWith("agentbridge-browse.js");
if (isDirectRun) main();
