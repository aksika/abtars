/**
 * peer-delegation-tools.ts — peer_delegate, peer_check, peer_terminate (#675).
 *
 * Remote delegation tools for the Orc. Uses PeerTransport to call
 * remote peers' /v1/tasks endpoints. Results tracked in local kanban
 * with type="remote" and meta JSON for peer + remote_task_id.
 */

import type { ToolDefinition } from "./tool-registry.js";
import { getPeerTransport } from "../peer-transport/index.js";
import { kanbanEnqueue, kanbanUpdate, kanbanComplete, kanbanFail } from "../tasks/kanban-board.js";
import { logInfo, logWarn } from "../logger.js";

const TAG = "peer-delegate";

export const peerDelegateTool: ToolDefinition = {
  name: "peer_delegate",
  description: "Delegate a task to a remote peer. Returns immediately with a local card ID. The remote peer executes autonomously. Use peer_check to poll status.",
  parameters: {
    type: "object",
    properties: {
      peer: { type: "string", description: "Peer name (from peers.json)" },
      goal: { type: "string", description: "Task goal/instructions for the remote peer" },
      priority: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"], description: "Task priority (default: MEDIUM)" },
      context: { type: "string", description: "Optional context to include" },
    },
    required: ["peer", "goal"],
  },
  async execute(args: Record<string, string>): Promise<string> {
    const { peer, goal, priority, context } = args;
    if (!peer || !goal) return JSON.stringify({ error: "peer and goal are required" });

    try {
      const transport = getPeerTransport();
      const remoteTaskId = await transport.delegateTask(peer, goal, { priority, context });

      // Create local kanban card to track the remote task
      const localCardId = kanbanEnqueue(`[remote:${peer}] ${goal.slice(0, 80)}`, "peer", undefined, {
        type: "remote",
        priority: priority ?? "MEDIUM",
        notes: JSON.stringify({ peer, remote_task_id: remoteTaskId, goal }),
      });

      logInfo(TAG, `Delegated to ${peer}: remote#${remoteTaskId} → local#${localCardId}`);
      return JSON.stringify({ ok: true, local_card_id: localCardId, remote_task_id: remoteTaskId, peer, status: "queued" });
    } catch (err) {
      logWarn(TAG, `peer_delegate failed: ${err instanceof Error ? err.message : String(err)}`);
      return JSON.stringify({ error: `peer_delegate failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  },
};

export const peerCheckTool: ToolDefinition = {
  name: "peer_check",
  description: "Check the status of a task delegated to a remote peer. Returns status and result if complete.",
  parameters: {
    type: "object",
    properties: {
      peer: { type: "string", description: "Peer name" },
      task_id: { type: "number", description: "Remote task ID (from peer_delegate result)" },
    },
    required: ["peer", "task_id"],
  },
  async execute(args: Record<string, string>): Promise<string> {
    const peer = args.peer;
    const taskId = parseInt(args.task_id, 10);
    if (!peer || isNaN(taskId)) return JSON.stringify({ error: "peer and task_id are required" });

    try {
      const transport = getPeerTransport();
      const result = await transport.checkTask(peer, taskId);
      return JSON.stringify({ ok: true, ...result });
    } catch (err) {
      logWarn(TAG, `peer_check failed: ${err instanceof Error ? err.message : String(err)}`);
      return JSON.stringify({ error: `peer_check failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  },
};

export const peerTerminateTool: ToolDefinition = {
  name: "peer_terminate",
  description: "Cancel/terminate a task running on a remote peer.",
  parameters: {
    type: "object",
    properties: {
      peer: { type: "string", description: "Peer name" },
      task_id: { type: "number", description: "Remote task ID to terminate" },
    },
    required: ["peer", "task_id"],
  },
  async execute(args: Record<string, string>): Promise<string> {
    const peer = args.peer;
    const taskId = parseInt(args.task_id, 10);
    if (!peer || isNaN(taskId)) return JSON.stringify({ error: "peer and task_id are required" });

    try {
      const transport = getPeerTransport();
      await transport.terminateTask(peer, taskId);
      logInfo(TAG, `Terminated remote task ${taskId} on ${peer}`);
      return JSON.stringify({ ok: true, terminated: true, peer, task_id: taskId });
    } catch (err) {
      logWarn(TAG, `peer_terminate failed: ${err instanceof Error ? err.message : String(err)}`);
      return JSON.stringify({ error: `peer_terminate failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  },
};

export function getPeerDelegationTools(): ToolDefinition[] {
  return [peerDelegateTool, peerCheckTool, peerTerminateTool];
}
