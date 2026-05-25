/**
 * Tool registry for DirectApiTransport.
 * Phase 2: native tool schemas. Phase 3: in-process memory when available.
 */

import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemoryBackend } from "abmind";
import type { InstantStoreParams } from "../../types/index.js";
import { logWarn, redactSecrets } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";

const TAG = "tool_registry";

// #449: append-only audit log
const AUDIT_DIR = join(process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars"), "logs");
const AUDIT_PATH = join(AUDIT_DIR, "audit.jsonl");
try { mkdirSync(AUDIT_DIR, { recursive: true }); } catch (err) { logAndSwallow(TAG, "mkdirSync audit dir", err); }
function audit(entry: Record<string, unknown>): void {
  try { appendFileSync(AUDIT_PATH, JSON.stringify(entry) + "\n"); } catch (err) { logAndSwallow(TAG, "audit write", err); }
}

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, string>, context?: { userId: string; signal?: AbortSignal }): Promise<string>;
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

/** Block kill/pkill/killall targeting the bridge's own PID or process patterns (#414). */
function isBridgeKillCommand(cmd: string): boolean {
  const pid = process.pid;
  const ppid = process.ppid;
  // Direct kill of own PID or parent
  if (new RegExp(`\\bkill\\s+(-\\d+\\s+)?${pid}\\b`).test(cmd)) return true;
  if (new RegExp(`\\bkill\\s+(-\\d+\\s+)?${ppid}\\b`).test(cmd)) return true;
  // pkill/killall targeting bridge patterns
  if (/\b(pkill|killall)\b.*\b(abtars|main\.js|watchdog)\b/.test(cmd)) return true;
  if (/\bkill\b.*\$\(.*pgrep.*abtars/.test(cmd)) return true;
  return false;
}

function runBash(cmd: string, timeout = BASH_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
  // Guardrails: command check
  const { checkCommand } = require("../guardrails.js") as typeof import("../guardrails.js");
  const cmdBlock = checkCommand(cmd);
  if (cmdBlock) {
    logWarn("tool-registry", `Guardrails blocked: ${cmd.slice(0, 200)}`);
    return Promise.resolve(JSON.stringify({ stderr: cmdBlock, exit_code: 126 }));
  }

  if (isBridgeSpawnCommand(cmd)) {
    logWarn("tool-registry", `Blocked bridge-spawn command: ${cmd.slice(0, 200)}`);
    return Promise.resolve(JSON.stringify({
      stderr: "Command blocked: this would spawn/restart a bridge or watchdog process. The bridge is already running under launchd+watchdog supervision; use launchctl inspection commands (launchctl list, launchctl print) or signal the existing process instead.",
      exit_code: 126,
    }));
  }
  if (isBridgeKillCommand(cmd)) {
    logWarn("tool-registry", `Blocked bridge-kill command: ${cmd.slice(0, 200)}`);
    return Promise.resolve(JSON.stringify({
      stderr: "Command blocked: this would kill the bridge process (yourself). Ask the user to send /restart for a session reset or restart the bridge manually.",
      exit_code: 126,
    }));
  }
  return new Promise((resolve) => {
    const child = execFile("bash", ["-c", cmd], { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const result: Record<string, unknown> = {};
      if (stdout) result["stdout"] = stdout.slice(0, 50_000);
      if (stderr) result["stderr"] = stderr.slice(0, 10_000);
      if (err) result["exit_code"] = (err as NodeJS.ErrnoException & { code?: number }).code ?? 1;
      else result["exit_code"] = 0;
      resolve(JSON.stringify(result));
    });
    if (signal) {
      if (signal.aborted) { child.kill("SIGTERM"); return; }
      const onAbort = (): void => { child.kill("SIGTERM"); };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("exit", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

let memoryBackend: MemoryBackend | null = null;

/** Wire in-process memory backend. Call once after memory init. */
export function setMemoryBackend(backend: MemoryBackend | null): void {
  memoryBackend = backend;
}

let _peerActivityCb: ((msg: string) => void) | null = null;

/** Wire peer activity notification callback. */
export function setPeerActivityCallback(cb: ((msg: string) => void) | null): void {
  _peerActivityCb = cb;
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
  execute: (args, context) => runBash(args["command"] ?? "", BASH_TIMEOUT_MS, context?.signal),
};

let _storeCount = 0;
const STORE_CAP = 20;

/** Reset store counter (called on new subagent session). */
export function resetStoreCounter(): void { _storeCount = 0; }

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
    if (++_storeCount > STORE_CAP) {
      return JSON.stringify({ stored: false, error: "Store limit reached for this session. Move to next task." });
    }
    if (memoryBackend) {
      try {
        const params: InstantStoreParams = {
          userId: context?.userId ?? "master",
          contentEn: args["translated"] ?? "",
          contentOriginal: args["original"] ?? args["translated"] ?? "",
          memoryType: (args["type"] ?? "fact") as InstantStoreParams["memoryType"],
          emotionScore: parseInt(args["emotion"] ?? "0", 10),
          confidence: parseInt(args["confidence"] ?? "3", 10),
          classification: parseInt(args["classification"] ?? "1", 10),
        };
        const result = await memoryBackend.instantStore({ ...params, createdBy: "tool:memory_store" });
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
          original: args["query"] ?? "",
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

let _secretGetDb: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } | null = null;

/** Inject DB handle for secret_get tool. */
export function setSecretGetDb(db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } }): void { _secretGetDb = db; }

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

const peerSessionTool: ToolDefinition = {
  name: "peer_session",
  description: "Open or continue a peer-to-peer session with another agent. Messages persist across turns. Use only when the user explicitly asks to contact another agent.",
  parameters: {
    type: "object",
    properties: {
      peer_name: { type: "string", description: "Name of the peer (as in peers.json)" },
      message: { type: "string", description: "Your message to the peer" },
      session_id: { type: "string", description: "Session ID from previous call (omit for new conversation)" },
    },
    required: ["peer_name", "message"],
  },
  async execute(args) {
    const { callPeer } = await import("../peer-client.js");
    const { loadPeerConfig } = await import("../peer-config.js");
    const { getOrCreateSession, addTurn, isEnded, destroySession } = await import("../peer-sessions.js");

    const peerName = args.peer_name?.trim();
    const message = args.message?.trim();
    if (!peerName || !message) return JSON.stringify({ error: "peer_name and message required" });

    const config = loadPeerConfig();
    if (peerName === config.self.name) return JSON.stringify({ error: "Cannot chat with yourself" });
    if (!config.peers[peerName]) return JSON.stringify({ error: `Unknown peer: ${peerName}` });

    const session = getOrCreateSession(args.session_id?.trim() || undefined, peerName);

    // Check turn cap before sending
    if (session.messages.length >= 20) {
      destroySession(session.id);
      return JSON.stringify({ session_id: session.id, response: "[SESSION_END] Turn limit reached.", ended: true, reason: "max-turns" });
    }

    addTurn(session, "user", message);

    // Build full conversation for peer (OpenAI messages format)
    const prompt = session.messages.map(m => `${m.role === "user" ? "You" : "Peer"}: ${m.content}`).join("\n") + "\n\nRespond to the latest message.";

    try {
      const response = await callPeer(peerName, prompt, config.maxHops);
      addTurn(session, "assistant", response);
      _peerActivityCb?.(`🤖 Agents: ${config.self.name} ↔ ${peerName} session. [turn ${session.messages.length}]`);

      const { ended, reason } = isEnded(session, response);
      if (ended) destroySession(session.id);

      return JSON.stringify({ session_id: session.id, response, ended, reason });
    } catch (err) {
      destroySession(session.id);
      return JSON.stringify({ error: `peer_session failed: ${err instanceof Error ? err.message : String(err)}`, session_id: session.id, ended: true });
    }
  },
};

const peerWakeupTool: ToolDefinition = {
  name: "peer_wakeup",
  description: "Send a wake-up signal to a peer that cannot reach us directly (firewall). The peer's bridge will call us back via A2A within seconds.",
  parameters: {
    type: "object",
    properties: {
      peer_name: { type: "string", description: "Name of the peer to wake up (as in peers.json)" },
    },
    required: ["peer_name"],
  },
  async execute(args) {
    const { sendWakeup } = await import("../dns-wakeup.js");
    const { loadPeerConfig } = await import("../peer-config.js");
    const peerName = args.peer_name?.trim();
    if (!peerName) return JSON.stringify({ error: "peer_name required" });
    const config = loadPeerConfig();
    const peer = config.peers[peerName];
    if (!peer) return JSON.stringify({ error: `Unknown peer: ${peerName}` });
    const udpPort = peer.udpPort ?? 5353;
    sendWakeup(config.self.name, peer.host, udpPort, peer.token);
    return JSON.stringify({ ok: true, message: `Wake-up sent to ${peerName}. Expect callback within seconds.` });
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

const secretGetTool: ToolDefinition = {
  name: "secret_get",
  description: "Retrieve a stored secret (class=3) and inject as env var. Returns the $VAR_NAME to use in commands. NEVER echoes the value to the user.",
  parameters: {
    properties: {
      name: { type: "string", description: "Keyword to search for (e.g. 'openrouter', 'github token')" },
    },
    required: ["name"],
  },
  execute: async (args) => {
    const keyword = args.name?.trim();
    if (!keyword) return JSON.stringify({ error: "name is required" });
    if (!_secretGetDb) return JSON.stringify({ error: "memory not available" });
    try {
      const { decrypt, hasKey } = await import("abmind");
      if (!hasKey()) return JSON.stringify({ error: "no encryption key" });
      const row = _secretGetDb.prepare(
        "SELECT content_en, encrypted FROM extracted_memories WHERE classification = 3 AND (content_en LIKE ? OR content_original LIKE ?) LIMIT 1"
      ).get(`%${keyword}%`, `%${keyword}%`) as { content_en: string; encrypted: number } | undefined;
      if (!row) return JSON.stringify({ error: `no secret found matching '${keyword}'` });
      const value = row.encrypted ? decrypt(row.content_en) : row.content_en;
      const varName = `SECRET_${keyword.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
      process.env[varName] = value;
      return JSON.stringify({ ok: true, env_var: `$${varName}`, hint: `Use $${varName} in commands. NEVER print or echo the value.` });
    } catch (err) {
      return JSON.stringify({ error: `secret_get failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  },
};

import { skillCreateTool } from "./skill-authoring.js";
import { mcpTool } from "./mcp-tool.js";
import { getDelegationTools } from "./delegation-tools.js";

const ALL_TOOLS: ToolDefinition[] = [bashTool, memoryStoreTool, memoryRecallTool, memoryEditTool, webBrowseTool, todoTool, taskTool, sendDocumentTool, peerSessionTool, peerWakeupTool, ircSendTool, secretGetTool, skillCreateTool, mcpTool, ...getDelegationTools()];

export function getToolDefinitions(): ToolDefinition[] { return ALL_TOOLS; }

export function getToolSchemas(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return ALL_TOOLS.map(t => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export async function executeToolCall(name: string, args: Record<string, string>, context?: { userId: string; signal?: AbortSignal }): Promise<string> {
  const tool = ALL_TOOLS.find(t => t.name === name);
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
  const ts = Date.now();
  audit({ ts, tool: name, args: redactSecrets(JSON.stringify(args)), userId: context?.userId });
  try {
    const result = await tool.execute(args, context);
    audit({ ts, tool: name, status: "ok", chars: result.length });
    return result;
  } catch (err) {
    audit({ ts, tool: name, status: "error", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
