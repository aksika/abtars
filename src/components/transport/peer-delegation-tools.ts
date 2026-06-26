/**
 * peer-delegation-tools.ts — peer_delegate, peer_check, peer_terminate (#675).
 *
 * Remote delegation tools for the Orc. Uses PeerTransport to call
 * remote peers' /v1/tasks endpoints. Results tracked in local kanban
 * with type="remote" and meta JSON for peer + remote_task_id.
 */

import type { ToolDefinition } from "./tool-registry.js";
import { getPeerTransport } from "../peer-transport/index.js";
import { kanbanEnqueue } from "../tasks/kanban-board.js";
import { logInfo, logWarn, logDebug, logTrace } from "../logger.js";

const TAG = "peer-delegate";

export const peerDelegateTool: ToolDefinition = {
  name: "peer_delegate",
  description: "Delegate a task to a remote peer. If peer is omitted, auto-selects the best capable peer by load. Use 'requires' to specify needed capabilities (gpu, docker, ollama, browser, xcode).",
  parameters: {
    type: "object",
    properties: {
      peer: { type: "string", description: "Peer name (optional — auto-selects if omitted)" },
      goal: { type: "string", description: "Task goal/instructions for the remote peer" },
      priority: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"], description: "Task priority (default: MEDIUM)" },
      context: { type: "string", description: "Optional context to include" },
      requires: { type: "array", items: { type: "string" }, description: "Required capabilities (e.g. ['gpu', 'docker'])" },
      artifacts: { type: "string", description: "JSON array of {name, content} objects (base64-encoded files to send)" },
    },
    required: ["goal"],
  },
  async execute(args: Record<string, string>): Promise<string> {
    const { goal, priority, context } = args;
    let peer = args.peer;
    const requires: string[] = args.requires ? (typeof args.requires === "string" ? JSON.parse(args.requires) : args.requires) : [];
    const artifacts: Array<{ name: string; content: string }> | undefined = args.artifacts ? JSON.parse(args.artifacts) : undefined;

    if (!goal) return JSON.stringify({ error: "goal is required" });

    // Auto-select peer if not specified
    if (!peer && requires.length > 0) {
      const { findCapablePeer } = await import("../peer-transport/gossip.js");
      const match = findCapablePeer(requires);
      if (!match) return JSON.stringify({ error: `No alive peer with capabilities: [${requires.join(", ")}]` });
      peer = match.name;
      logDebug(TAG, `Auto-selected peer ${peer} for requires=[${requires.join(",")}] (load=${match.load})`);
    } else if (!peer) {
      // No peer, no requires — pick least loaded
      const { getPeerTable } = await import("../peer-transport/gossip.js");
      const alive = getPeerTable().sort((a, b) => a.load - b.load);
      if (alive.length === 0) return JSON.stringify({ error: "No alive peers available" });
      peer = alive[0]!.name;
      logDebug(TAG, `Auto-selected least-loaded peer ${peer} (load=${alive[0]!.load})`);
    }

    // Validate capabilities if requires specified + explicit peer
    if (requires.length > 0 && args.peer) {
      const { getPeerTable } = await import("../peer-transport/gossip.js");
      const entry = getPeerTable(true).find(p => p.name.toLowerCase() === peer!.toLowerCase());
      if (entry && !requires.every(r => entry.capabilities.includes(r))) {
        const missing = requires.filter(r => !entry.capabilities.includes(r));
        return JSON.stringify({ error: `Peer ${peer} lacks capabilities: [${missing.join(", ")}]` });
      }
    }

    logDebug(TAG, `peer_delegate: peer=${peer} priority=${priority ?? "MEDIUM"} goal=${goal.length}ch requires=[${requires.join(",")}]`);
    logTrace(TAG, `peer_delegate goal: ${goal.slice(0, 500)}`);

    try {
      const transport = getPeerTransport();
      const { taskId: remoteTaskId, remoteSessionId } = await transport.delegateTask(peer, goal, { priority, context, artifacts });

      const localCardId = kanbanEnqueue(`[remote:${peer}] ${goal.slice(0, 80)}`, "peer", undefined, {
        type: "remote",
        priority: priority ?? "MEDIUM",
        notes: JSON.stringify({ peer, remote_task_id: remoteTaskId, remote_session_id: remoteSessionId, goal, requires }),
      });

      // #949: Create hollow session to track remote worker locally
      if (remoteSessionId) {
        const { spin } = await import("../spin.js");
        const { getMasterUserId } = await import("../../boot/phase-config.js");
        spin.createHollowSession(getMasterUserId(), "telegram", "W", peer, remoteSessionId);
      }

      logInfo(TAG, `Delegated to ${peer}: remote#${remoteTaskId} → local#${localCardId}`);
      return JSON.stringify({ ok: true, local_card_id: localCardId, remote_task_id: remoteTaskId, remote_session_id: remoteSessionId, peer, status: "queued" });
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
    const taskId = parseInt(args.task_id ?? "", 10);
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
    const taskId = parseInt(args.task_id ?? "", 10);
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
