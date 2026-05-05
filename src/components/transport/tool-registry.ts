/**
 * Tool registry for DirectApiTransport.
 * Phase 2: native tool schemas. Phase 3: in-process memory when available.
 */

import { execFile } from "node:child_process";
import type { MemoryBackend } from "abmind";
import type { InstantStoreParams } from "../../types/index.js";
import { logWarn } from "../logger.js";

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, string>, context?: { userId: string }): Promise<string>;
};

const BASH_TIMEOUT_MS = 300_000;
const CLI_TIMEOUT_MS = 60_000;

/**
 * Patterns that would spawn or restart a bridge/watchdog process.
 * Blocked to prevent the LLM (especially fallback models) from accidentally
 * starting a second bridge instance, which would cause port conflicts,
 * Telegram 409 errors, and bridge.lock PID confusion.
 *
 * See post-mortem of 2026-04-22 outage: cron agent ran execute_bash that
 * spawned a rogue bridge alongside the watchdog-supervised one.
 */
const BLOCKED_PATTERNS: readonly RegExp[] = [
  /\bmain\.js\b/,                                  // node .../current/dist/main.js ...
  /\babtars\.sh\b/,                           // the launcher
  /\bwatchdog\.sh\b/,                              // the watchdog
  /\blaunchctl\s+(load|bootstrap|kickstart|start)\b/, // launchd bridge start
];

export function isBridgeSpawnCommand(cmd: string): boolean {
  return BLOCKED_PATTERNS.some(p => p.test(cmd));
}

function runBash(cmd: string, timeout = BASH_TIMEOUT_MS): Promise<string> {
  if (isBridgeSpawnCommand(cmd)) {
    logWarn("tool-registry", `Blocked bridge-spawn command: ${cmd.slice(0, 200)}`);
    return Promise.resolve(JSON.stringify({
      stderr: "Command blocked: this would spawn/restart a bridge or watchdog process. The bridge is already running under launchd+watchdog supervision; use launchctl inspection commands (launchctl list, launchctl print) or signal the existing process instead.",
      exit_code: 126,
    }));
  }
  return new Promise((resolve) => {
    execFile("bash", ["-c", cmd], { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const result: Record<string, unknown> = {};
      if (stdout) result["stdout"] = stdout.slice(0, 50_000);
      if (stderr) result["stderr"] = stderr.slice(0, 10_000);
      if (err) result["exit_code"] = (err as NodeJS.ErrnoException & { code?: number }).code ?? 1;
      else result["exit_code"] = 0;
      resolve(JSON.stringify(result));
    });
  });
}

let memoryBackend: MemoryBackend | null = null;

/** Wire in-process memory backend. Call once after memory init. */
export function setMemoryBackend(backend: MemoryBackend | null): void {
  memoryBackend = backend;
}

// --- Tool definitions ---

const bashTool: ToolDefinition = {
  name: "execute_bash",
  description: "Execute a bash command. Use for file operations, git, running scripts, and any shell command. Commands that would spawn or restart a bridge/watchdog process (node main.js, abtars.sh, watchdog.sh, launchctl load/bootstrap/kickstart/start) are blocked — the bridge is already supervised.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "The bash command to execute" } },
    required: ["command"],
  },
  execute: (args) => runBash(args["command"] ?? ""),
};

const memoryStoreTool: ToolDefinition = {
  name: "memory_store",
  description: "Store a memory. Use after learning something about the user, their preferences, decisions, or facts worth remembering.",
  parameters: {
    type: "object",
    properties: {
      translated: { type: "string", description: "Memory content in English" },
      original: { type: "string", description: "Memory content in original language (if not English)" },
      type: { type: "string", enum: ["fact", "preference", "decision", "experience", "skill", "relationship", "goal"], description: "Memory type" },
      emotion: { type: "integer", description: "Emotion score -5 to +5 (0=neutral)" },
      confidence: { type: "integer", description: "Confidence 1-5 (3=default)" },
      classification: { type: "integer", description: "0=public (general knowledge), 1=internal (default), 2=confidential (personal preferences, habits, opinions about specific users), 3=secret (credentials, API keys, tokens, passwords — store IMMEDIATELY with exact string, never paraphrase, never wait for Dreamy)" },
    },
    required: ["translated", "type"],
  },
  async execute(args, context): Promise<string> {
    if (memoryBackend) {
      try {
        const params: InstantStoreParams = {
          userId: context?.userId ?? "master",
          contentEn: args["translated"] ?? "",
          contentOriginal: args["original"] ?? args["translated"] ?? "",
          memoryType: (args["type"] ?? "fact") as InstantStoreParams["memoryType"],
          emotionScore: parseInt(args["emotion"] ?? "0", 10),
          confidence: parseInt(args["confidence"] ?? "3", 10),
          classification: parseInt(args["classification"] ?? "0", 10),
        };
        const result = await memoryBackend.instantStore(params);
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    let cmd = `abmind store --translated ${JSON.stringify(args["translated"] ?? "")} --type ${args["type"] ?? "fact"}`;
    if (args["original"]) cmd += ` --original ${JSON.stringify(args["original"])}`;
    if (args["emotion"]) cmd += ` --emotion-score ${args["emotion"]}`;
    if (args["confidence"]) cmd += ` --confidence ${args["confidence"]}`;
    if (args["classification"]) cmd += ` --classification ${args["classification"]}`;
    return runBash(cmd, CLI_TIMEOUT_MS);
  },
};

const memoryRecallTool: ToolDefinition = {
  name: "memory_recall",
  description: "Search memories by keyword or semantic query. Returns relevant stored memories.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "integer", description: "Max results (default 10)" },
    },
    required: ["query"],
  },
  async execute(args, context): Promise<string> {
    if (memoryBackend) {
      try {
        const result = await memoryBackend.recall({
          translated: [args["query"] ?? ""],
          userId: context?.userId ?? "master",
          limit: parseInt(args["limit"] ?? "10", 10),
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    let cmd = `abmind recall ${JSON.stringify(args["query"] ?? "")}`;
    if (args["limit"]) cmd += ` --limit ${args["limit"]}`;
    return runBash(cmd, CLI_TIMEOUT_MS);
  },
};

const memoryEditTool: ToolDefinition = {
  name: "memory_edit",
  description: "Edit an existing memory by ID. Change content, type, emotion, confidence, or classification.",
  parameters: {
    type: "object",
    properties: {
      memory_id: { type: "integer", description: "Memory ID to edit" },
      translated: { type: "string", description: "New English content" },
      original: { type: "string", description: "New original language content" },
      type: { type: "string", description: "New memory type" },
      emotion: { type: "integer", description: "New emotion score" },
      confidence: { type: "integer", description: "New confidence" },
      classification: { type: "integer", description: "New classification" },
      caller: { type: "string", enum: ["kp", "dreamy"], description: "Who is making the edit" },
    },
    required: ["memory_id"],
  },
  async execute(args): Promise<string> {
    if (memoryBackend) {
      try {
        const result = await memoryBackend.editMemory({
          memoryId: parseInt(args["memory_id"] ?? "0", 10),
          contentEn: args["translated"],
          contentOriginal: args["original"],
          memoryType: args["type"] as "fact" | "decision" | "preference" | "event" | undefined,
          emotionScore: args["emotion"] ? parseInt(args["emotion"], 10) : undefined,
          confidence: args["confidence"] ? parseInt(args["confidence"], 10) : undefined,
          classification: args["classification"] ? parseInt(args["classification"], 10) : undefined,
          caller: (args["caller"] ?? "kp") as "kp" | "dreamy",
        });
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    let cmd = `abmind edit --memory-id ${args["memory_id"] ?? "0"}`;
    if (args["translated"]) cmd += ` --translated ${JSON.stringify(args["translated"])}`;
    if (args["original"]) cmd += ` --original ${JSON.stringify(args["original"])}`;
    if (args["type"]) cmd += ` --type ${args["type"]}`;
    if (args["emotion"]) cmd += ` --emotion-score ${args["emotion"]}`;
    if (args["confidence"]) cmd += ` --confidence ${args["confidence"]}`;
    if (args["classification"]) cmd += ` --classification ${args["classification"]}`;
    if (args["caller"]) cmd += ` --caller ${args["caller"]}`;
    return runBash(cmd, CLI_TIMEOUT_MS);
  },
};

const webBrowseTool: ToolDefinition = {
  name: "web_browse",
  description: "Browse a URL or perform a complex multi-step web task. For quick lookups use execute_bash with curl.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "What to do on the web" },
      chat_id: { type: "string", description: "Chat ID for result delivery" },
      engine: { type: "string", enum: ["patchright"], description: "Browser engine (default: patchright)" },
    },
    required: ["task", "chat_id"],
  },
  execute: (args) => {
    let cmd = `abtars-browse --task ${JSON.stringify(args["task"] ?? "")} --chat-id ${args["chat_id"] ?? "0"}`;
    if (args["engine"]) cmd += ` --engine ${args["engine"]}`;
    return runBash(cmd, CLI_TIMEOUT_MS);
  },
};

const todoTool: ToolDefinition = {
  name: "todo_manage",
  description: "Manage TODO items. Add, complete, or list tasks.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "done", "list", "remove"], description: "Action to perform" },
      text: { type: "string", description: "TODO text (for add)" },
      id: { type: "string", description: "TODO ID (for done/remove)" },
    },
    required: ["action"],
  },
  execute: (args) => {
    const action = args["action"] ?? "list";
    if (action === "add") return runBash(`abtars-todo add ${JSON.stringify(args["text"] ?? "")}`, CLI_TIMEOUT_MS);
    if (action === "done") return runBash(`abtars-todo done ${args["id"] ?? ""}`, CLI_TIMEOUT_MS);
    if (action === "remove") return runBash(`abtars-todo remove ${args["id"] ?? ""}`, CLI_TIMEOUT_MS);
    return runBash("abtars-todo list", CLI_TIMEOUT_MS);
  },
};

let _enqueueCron: ((id: string, manual?: boolean) => string | null) | null = null;

/** Inject enqueueCron from bridge for task_manage --run. */
export function setEnqueueCron(fn: (id: string, manual?: boolean) => string | null): void { _enqueueCron = fn; }

let _ircSend: ((channel: string, message: string) => void) | null = null;

/** Inject IRC send from bridge for irc_send tool. */
export function setIrcSend(fn: (channel: string, message: string) => void): void { _ircSend = fn; }

let _sendDocument: ((path: string, caption?: string) => Promise<number>) | null = null;

/**
 * Inject sendDocument from bridge for the send_document tool.
 * Caller binds main chat id + telegram adapter; tool is a thin wrapper around that.
 */
export function setSendDocument(fn: ((path: string, caption?: string) => Promise<number>) | null): void { _sendDocument = fn; }

const sendDocumentTool: ToolDefinition = {
  name: "send_document",
  description: "Send a file from disk to the user's Telegram chat. Use for delivering reports, daily summaries, logs, or any .md file the user asks for. Do not summarize — the raw file is sent as an attachment.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file" },
      caption: { type: "string", description: "Optional short caption (≤1024 chars)" },
    },
    required: ["path"],
  },
  execute: async (args) => {
    const path = args["path"];
    if (!path) return JSON.stringify({ error: "path is required" });
    if (!_sendDocument) return JSON.stringify({ error: "Telegram not configured (sendDocument unavailable)" });
    try {
      const messageId = await _sendDocument(path, args["caption"]);
      return JSON.stringify({ ok: true, message_id: messageId });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  },
};

const taskTool: ToolDefinition = {
  name: "task_manage",
  description: "Manage scheduled/recurring tasks (cron). Add, list, remove, pause, resume, or run tasks. Use action=run to execute a task immediately via the cron queue (isolated subagent).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "list", "remove", "pause", "resume", "run"], description: "Action" },
      message: { type: "string", description: "Task message/command (for add)" },
      schedule: { type: "string", description: "Cron schedule expression (for add)" },
      type: { type: "string", enum: ["reminder", "script", "agent"], description: "Task type (for add)" },
      chat_id: { type: "string", description: "Chat ID (for add)" },
      id: { type: "string", description: "Task ID (for remove/pause/resume/run)" },
    },
    required: ["action"],
  },
  execute: (args) => {
    const action = args["action"] ?? "list";
    if (action === "list") return runBash("abtars-task list", CLI_TIMEOUT_MS);
    if (action === "remove") return runBash(`abtars-task remove ${args["id"] ?? ""}`, CLI_TIMEOUT_MS);
    if (action === "pause") return runBash(`abtars-task pause ${args["id"] ?? ""}`, CLI_TIMEOUT_MS);
    if (action === "resume") return runBash(`abtars-task resume ${args["id"] ?? ""}`, CLI_TIMEOUT_MS);
    if (action === "run") {
      if (!_enqueueCron) return Promise.resolve(JSON.stringify({ error: "enqueueCron not available" }));
      const err = _enqueueCron(args["id"] ?? "", true);
      return Promise.resolve(JSON.stringify(err ? { error: err } : { ok: true, message: `Task ${args["id"]} enqueued for immediate execution` }));
    }
    let cmd = `abtars-task add --message ${JSON.stringify(args["message"] ?? "")}`;
    if (args["schedule"]) cmd += ` --schedule ${JSON.stringify(args["schedule"])}`;
    if (args["type"]) cmd += ` --type ${args["type"]}`;
    if (args["chat_id"]) cmd += ` --chat-id ${args["chat_id"]}`;
    return runBash(cmd, CLI_TIMEOUT_MS);
  },
};

const peerAskTool: ToolDefinition = {
  name: "peer_ask",
  description: "Ask a peer abtars instance a question. Use for cross-instance delegation (e.g. ask Molty or KP). Returns the peer's full response.",
  parameters: {
    type: "object",
    properties: {
      peer_name: { type: "string", description: "Name of the peer (as configured in peers.json)" },
      prompt: { type: "string", description: "The question or request to send to the peer" },
    },
    required: ["peer_name", "prompt"],
  },
  async execute(args) {
    const { callPeer, PeerCallError, getCurrentPeerHops } = await import("../peer-client.js");
    const { loadPeerConfig } = await import("../peer-config.js");
    const peerName = args.peer_name?.trim();
    const prompt = args.prompt?.trim();
    if (!peerName || !prompt) return JSON.stringify({ error: "peer_name and prompt are required" });

    const config = loadPeerConfig();
    // Determine hops to send: decrement from current request's budget, or use maxHops for direct calls
    const incomingHops = getCurrentPeerHops();
    const hops = incomingHops !== null ? Math.min(incomingHops - 1, config.maxHops) : config.maxHops;
    if (hops <= 0) return JSON.stringify({ error: "Hop limit reached — cannot forward to another peer from this depth" });

    try {
      return await callPeer(peerName, prompt, hops);
    } catch (err) {
      if (err instanceof PeerCallError) return JSON.stringify({ error: `peer_ask failed: ${err.message} (${err.code})` });
      return JSON.stringify({ error: `peer_ask failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  },
};

const ircSendTool: ToolDefinition = {
  name: "irc_send",
  description: "Send a message to an IRC channel (e.g. #bridges)",
  parameters: {
    channel: { type: "string", description: "IRC channel (e.g. #bridges)" },
    message: { type: "string", description: "Message text to send" },
  },
  execute: async (args) => {
    if (!_ircSend) return JSON.stringify({ error: "IRC adapter not connected" });
    const channel = args["channel"] ?? "";
    const message = args["message"] ?? "";
    if (!channel || !message) return JSON.stringify({ error: "channel and message are required" });
    _ircSend(channel, message);
    return JSON.stringify({ ok: true, channel, sent: message.length + " chars" });
  },
};

const ALL_TOOLS: ToolDefinition[] = [bashTool, memoryStoreTool, memoryRecallTool, memoryEditTool, webBrowseTool, todoTool, taskTool, sendDocumentTool, peerAskTool, ircSendTool];

export function getToolDefinitions(): ToolDefinition[] { return ALL_TOOLS; }

export function getToolSchemas(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return ALL_TOOLS.map(t => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export async function executeToolCall(name: string, args: Record<string, string>, context?: { userId: string }): Promise<string> {
  const tool = ALL_TOOLS.find(t => t.name === name);
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
  return tool.execute(args, context);
}
