/**
 * delegation-tools.ts — spawn_session, check_session, terminate_session (#570).
 * Gated behind ENABLE_ASYNC_DELEGATION env flag.
 */

import type { ToolDefinition } from "./tool-registry.js";
import type { SubagentRuntime, AgentName } from "../subagent-runtime.js";
import type { SessionType } from "../spin-types.js";
import { spin } from "../spin.js";
import { addCompletion } from "../completion-buffer.js";
import { logInfo, logWarn } from "../logger.js";
import { getEnv } from "../env-schema.js";

const TAG = "delegation";
const MAX_BACKGROUND = parseInt(process.env["MAX_BACKGROUND_SESSIONS"] ?? "3", 10);

let _runtime: SubagentRuntime | null = null;

export function setDelegationDeps(runtime: SubagentRuntime): void {
  _runtime = runtime;
}

// Track active background sessions: taskId → metadata
interface BackgroundEntry {
  taskId: string;
  sessionId: string;
  goal: string;
  startedAt: number;
  status: "running" | "done" | "failed" | "terminated" | "timeout";
  result?: string;
  inputTokens: number;
  outputTokens: number;
  pendingInstruction?: string;
}

const activeBackgrounds = new Map<string, BackgroundEntry>();

export function getActiveBackgrounds(): Map<string, BackgroundEntry> {
  return activeBackgrounds;
}

const TYPE_MAP: Record<string, { sessionType: SessionType; agent: AgentName }> = {
  code: { sessionType: "C", agent: "coding" },
  browse: { sessionType: "B", agent: "browsie" },
  task: { sessionType: "T", agent: "task" },
};

export const spawnSessionTool: ToolDefinition = {
  name: "spawn_session",
  description: "Spawn a background session that works independently. Returns immediately with a session ID. Use check_session to get results later.",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["code", "browse", "task"], description: "Session type" },
      goal: { type: "string", description: "What the sub-agent should accomplish" },
      context: { type: "string", description: "Optional context/instructions" },
    },
    required: ["type", "goal"],
  },
  async execute(args) {
    if (!_runtime) return JSON.stringify({ error: "Delegation not initialized" });

    const typeInfo = TYPE_MAP[args.type ?? "task"];
    if (!typeInfo) return JSON.stringify({ error: `Unknown type: ${args.type}. Use: code, browse, task` });

    // Check cap
    const running = [...activeBackgrounds.values()].filter(e => e.status === "running");
    if (running.length >= MAX_BACKGROUND) {
      return JSON.stringify({ error: `Max ${MAX_BACKGROUND} concurrent background sessions. Wait for one to finish or terminate it.` });
    }

    // Create session via session manager
    const masterUid = (await import("../master-user.js")).getMasterUserId();
    const session = spin.createSubSession(masterUid, "telegram", typeInfo.sessionType);
    if (typeof session === "string") return JSON.stringify({ error: session });

    const goal = args.goal ?? "No goal specified";
    const prompt = args.context ? `${args.context}\n\nTask: ${goal}` : goal;

    // Spawn via SubagentRuntime (fire-and-forget)
    const { taskId } = await _runtime.spawn(typeInfo.agent, prompt, {
      onComplete: (id, result) => {
        const entry = activeBackgrounds.get(id);
        if (entry) {
          entry.status = "done";
          entry.result = result.slice(0, 4000);
          addCompletion({
            sessionId: entry.sessionId,
            motherId: session.motherId ?? "",
            goal: entry.goal,
            status: "done",
            result: entry.result,
            elapsedMs: Date.now() - entry.startedAt,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
          });
          logInfo(TAG, `Background ${id} completed (${Date.now() - entry.startedAt}ms)`);
        }
      },
      onError: (id, err) => {
        const entry = activeBackgrounds.get(id);
        if (entry) {
          entry.status = "failed";
          entry.result = err.message.slice(0, 1000);
          addCompletion({
            sessionId: entry.sessionId,
            motherId: session.motherId ?? "",
            goal: entry.goal,
            status: "failed",
            result: entry.result,
            elapsedMs: Date.now() - entry.startedAt,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
          });
          logWarn(TAG, `Background ${id} failed: ${err.message}`);
        }
      },
    });

    activeBackgrounds.set(taskId, {
      taskId,
      sessionId: session.id,
      goal,
      startedAt: Date.now(),
      status: "running",
      inputTokens: 0,
      outputTokens: 0,
    });

    logInfo(TAG, `Spawned background: taskId=${taskId}, session=${session.id}, goal="${goal.slice(0, 60)}"`);
    return JSON.stringify({ session_id: session.id, task_id: taskId, status: "running" });
  },
};

export const checkSessionTool: ToolDefinition = {
  name: "check_session",
  description: "Check the status of a background session. Returns status and result if completed.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task ID returned by spawn_session" },
    },
    required: ["task_id"],
  },
  async execute(args) {
    const entry = activeBackgrounds.get(args.task_id ?? "");
    if (!entry) return JSON.stringify({ error: `No background session found with task_id: ${args.task_id}` });

    const elapsed = Math.round((Date.now() - entry.startedAt) / 1000);
    return JSON.stringify({
      task_id: entry.taskId,
      session_id: entry.sessionId,
      goal: entry.goal,
      status: entry.status,
      elapsed_seconds: elapsed,
      result: entry.result ?? null,
    });
  },
};

export const terminateSessionTool: ToolDefinition = {
  name: "terminate_session",
  description: "Terminate a running background session. It finishes its current operation then stops.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task ID to terminate" },
    },
    required: ["task_id"],
  },
  async execute(args) {
    if (!_runtime) return JSON.stringify({ error: "Delegation not initialized" });

    const entry = activeBackgrounds.get(args.task_id ?? "");
    if (!entry) return JSON.stringify({ error: `No background session found with task_id: ${args.task_id}` });
    if (entry.status !== "running") return JSON.stringify({ error: `Session already ${entry.status}` });

    const interrupted = _runtime.interruptSpawn(entry.taskId);
    entry.status = "terminated";
    entry.result = "(terminated by user)";

    if (entry.sessionId) {
      const managed = spin.getSessionById(entry.sessionId);
      if (managed) managed.status = "paused";
    }

    addCompletion({
      sessionId: entry.sessionId,
      motherId: spin.getSessionById(entry.sessionId)?.motherId ?? "",
      goal: entry.goal,
      status: "terminated",
      result: entry.result,
      elapsedMs: Date.now() - entry.startedAt,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
    });

    logInfo(TAG, `Terminated background ${entry.taskId} (interrupted=${interrupted})`);
    return JSON.stringify({ task_id: entry.taskId, status: "terminated" });
  },
};

export const sendToSessionTool: ToolDefinition = {
  name: "send_to_session",
  description: "Send a follow-up instruction to a running background session. The child receives it on its next turn.",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task ID of the running session" },
      message: { type: "string", description: "Instruction to send" },
    },
    required: ["task_id", "message"],
  },
  async execute(args) {
    const entry = activeBackgrounds.get(args.task_id ?? "");
    if (!entry) return JSON.stringify({ error: `No background session found with task_id: ${args.task_id}` });
    if (entry.status !== "running") return JSON.stringify({ error: `Session is ${entry.status}, cannot send instruction` });
    entry.pendingInstruction = args.message;
    logInfo(TAG, `Instruction queued for ${entry.taskId}: "${(args.message ?? "").slice(0, 60)}"`);
    return JSON.stringify({ delivered: true, task_id: entry.taskId });
  },
};

/** Check and consume pending instruction for a task. Used by agent loop. */
export function consumePendingInstruction(taskId: string): string | undefined {
  const entry = activeBackgrounds.get(taskId);
  if (!entry?.pendingInstruction) return undefined;
  const msg = entry.pendingInstruction;
  entry.pendingInstruction = undefined;
  return msg;
}

export function getDelegationTools(): ToolDefinition[] {
  if (!getEnv().enableAsyncDelegation) return [];
  return [spawnSessionTool, checkSessionTool, terminateSessionTool, sendToSessionTool];
}
