/**
 * Tool registry for DirectApiTransport.
 * Phase 2: native tool schemas. Phase 3: in-process memory when available.
 */

import { execFile } from "node:child_process";
import type { MemoryBackend } from "@agentbridge/memory/memory-backend.js";
import type { InstantStoreParams } from "../../types/index.js";

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, string>): Promise<string>;
};

const BASH_TIMEOUT_MS = 300_000;
const CLI_TIMEOUT_MS = 60_000;

function runBash(cmd: string, timeout = BASH_TIMEOUT_MS): Promise<string> {
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
  description: "Execute a bash command. Use for file operations, git, running scripts, and any shell command.",
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
      classification: { type: "integer", description: "0=public, 1=internal, 2=confidential" },
    },
    required: ["translated", "type"],
  },
  async execute(args): Promise<string> {
    if (memoryBackend) {
      try {
        const params: InstantStoreParams = {
          chatId: 0,
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
  async execute(args): Promise<string> {
    if (memoryBackend) {
      try {
        const result = await memoryBackend.recall({
          translated: [args["query"] ?? ""],
          chatId: 0,
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
      engine: { type: "string", enum: ["lightpanda", "patchright"], description: "Browser engine (default: patchright)" },
    },
    required: ["task", "chat_id"],
  },
  execute: (args) => {
    let cmd = `agentbridge-browse --task ${JSON.stringify(args["task"] ?? "")} --chat-id ${args["chat_id"] ?? "0"}`;
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
    if (action === "add") return runBash(`agentbridge-todo add ${JSON.stringify(args["text"] ?? "")}`, CLI_TIMEOUT_MS);
    if (action === "done") return runBash(`agentbridge-todo done ${args["id"] ?? ""}`, CLI_TIMEOUT_MS);
    if (action === "remove") return runBash(`agentbridge-todo remove ${args["id"] ?? ""}`, CLI_TIMEOUT_MS);
    return runBash("agentbridge-todo list", CLI_TIMEOUT_MS);
  },
};

const taskTool: ToolDefinition = {
  name: "task_manage",
  description: "Manage scheduled/recurring tasks (cron). Add, list, remove, pause, resume, or trigger tasks.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "list", "remove", "pause", "resume", "trigger"], description: "Action" },
      message: { type: "string", description: "Task message/command (for add)" },
      schedule: { type: "string", description: "Cron schedule expression (for add)" },
      type: { type: "string", enum: ["reminder", "script", "agent"], description: "Task type (for add)" },
      chat_id: { type: "string", description: "Chat ID (for add)" },
      id: { type: "string", description: "Task ID (for remove/pause/resume/trigger)" },
    },
    required: ["action"],
  },
  execute: (args) => {
    const action = args["action"] ?? "list";
    if (action === "list") return runBash("agentbridge-task list", CLI_TIMEOUT_MS);
    if (action === "remove") return runBash(`agentbridge-task remove ${args["id"] ?? ""}`, CLI_TIMEOUT_MS);
    if (action === "pause") return runBash(`agentbridge-task pause ${args["id"] ?? ""}`, CLI_TIMEOUT_MS);
    if (action === "resume") return runBash(`agentbridge-task resume ${args["id"] ?? ""}`, CLI_TIMEOUT_MS);
    if (action === "trigger") return runBash(`agentbridge-task trigger ${args["id"] ?? ""}`, CLI_TIMEOUT_MS);
    let cmd = `agentbridge-task add --message ${JSON.stringify(args["message"] ?? "")}`;
    if (args["schedule"]) cmd += ` --schedule ${JSON.stringify(args["schedule"])}`;
    if (args["type"]) cmd += ` --type ${args["type"]}`;
    if (args["chat_id"]) cmd += ` --chat-id ${args["chat_id"]}`;
    return runBash(cmd, CLI_TIMEOUT_MS);
  },
};

const ALL_TOOLS: ToolDefinition[] = [bashTool, memoryStoreTool, memoryRecallTool, memoryEditTool, webBrowseTool, todoTool, taskTool];

export function getToolDefinitions(): ToolDefinition[] { return ALL_TOOLS; }

export function getToolSchemas(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return ALL_TOOLS.map(t => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export async function executeToolCall(name: string, args: Record<string, string>): Promise<string> {
  const tool = ALL_TOOLS.find(t => t.name === name);
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
  return tool.execute(args);
}
