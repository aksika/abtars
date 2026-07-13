/**
 * peer-delegation-tools.ts — peer_delegate, peer_check, peer_terminate (#675/#1357).
 */

import type { ToolDefinition } from "./tool-registry.js";
import type { RemotePiTargetV1 } from "../peer-transport/interface.js";
import { getPeerTransport } from "../peer-transport/index.js";
import { kanbanEnqueue, kanbanFindRemoteDelegation, kanbanUpdate } from "../tasks/kanban-board.js";
import { logInfo, logWarn, logDebug, logTrace } from "../logger.js";
import { randomUUID } from "node:crypto";

const TAG = "peer-delegate";

export const peerDelegateTool: ToolDefinition = {
  name: "peer_delegate",
  description: "Delegate a task to a remote peer. If peer is omitted, auto-selects the best capable peer by load. Use 'requires' to specify needed capabilities. For Pi coding delegation, set executor='pi' and workspace_alias.",
  parameters: {
    type: "object",
    properties: {
      peer: { type: "string", description: "Peer name (optional — auto-selects if omitted)" },
      goal: { type: "string", description: "Task goal/instructions for the remote peer" },
      priority: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"], description: "Task priority (default: MEDIUM)" },
      context: { type: "string", description: "Optional context to include" },
      requires: { type: "array", items: { type: "string" }, description: "Required capabilities (e.g. ['gpu', 'docker'])" },
      artifacts: { type: "string", description: "JSON array of {name, content} objects (base64-encoded files to send)" },
      worker_contract: { type: "string", description: "JSON string of WorkerAcceptanceContractV1 (#1366)" },
      attempt_id: { type: "string", description: "Pre-allocated attempt ID (#1366)" },
      executor: { type: "string", enum: ["agent", "pi"], description: "Execution target type. 'pi' activates Pi coding delegation (#1357)" },
      workspace_alias: { type: "string", description: "Peer-local workspace alias (required when executor='pi')" },
      model: { type: "string", description: "JSON object {provider, model_id, thinking?} for Pi execution" },
      delivery: { type: "string", enum: ["commit_push", "patch_artifact", "leave_remote"], description: "Delivery policy for Pi results" },
      request_id: { type: "string", description: "Stable request ID for a safe retry after an unknown network outcome" },
    },
    required: ["goal"],
  },
  async execute(args: Record<string, string>): Promise<string> {
    const { isActiveCardPeerSourced } = await import("./orc-tools.js");
    if (await isActiveCardPeerSourced()) {
      return JSON.stringify({ error: "Relaying to other peers is not permitted for peer-originated requests. Peers communicate directly.", reason: "peer_relay_blocked" });
    }
    const { goal, priority, context, executor } = args;
    let peer = args.peer;
    const requires: string[] = args.requires ? (typeof args.requires === "string" ? JSON.parse(args.requires) : args.requires) : [];
    const artifacts: Array<{ name: string; content: string }> | undefined = args.artifacts ? JSON.parse(args.artifacts) : undefined;

    if (!goal) return JSON.stringify({ error: "goal is required" });

    // #1357: Build Pi target if executor === "pi"
    let target: RemotePiTargetV1 | undefined;
    let effectiveRequires = [...requires];
    if (executor === "pi") {
      const workspaceAlias = args.workspace_alias;
      if (!workspaceAlias || typeof workspaceAlias !== "string") {
        return JSON.stringify({ error: "workspace_alias is required when executor='pi'" });
      }
      if (!/^[a-z][a-z0-9_.\-]{0,63}$/.test(workspaceAlias)) {
        return JSON.stringify({ error: `Invalid workspace_alias "${workspaceAlias}" — must match [a-z][a-z0-9_.-]{0,63}` });
      }
      target = { executor: "pi", workspace_alias: workspaceAlias };
      if (args.model) {
        try {
          const m = typeof args.model === "string" ? JSON.parse(args.model) : args.model;
          if (m.provider && m.model_id) target.model = { provider: m.provider, model_id: m.model_id, thinking: m.thinking };
        } catch { return JSON.stringify({ error: "model must be valid JSON {provider, model_id, thinking?}" }); }
      }
      if (args.delivery) target.delivery = args.delivery as "commit_push" | "patch_artifact" | "leave_remote";

      // Effective requirements = caller's requires + pi-executor + workspace:<alias>
      effectiveRequires.push("pi-executor", `workspace:${workspaceAlias}`);
    }

    // Deduplicate effective requirements
    const deduped = [...new Set(effectiveRequires)].sort();

    if (target && artifacts?.length) {
      return JSON.stringify({ error: "Artifacts are not supported for Pi delegation" });
    }

    // Auto-select peer by effective capabilities
    if (!peer && deduped.length > 0) {
      const { findCapablePeer } = await import("../peer-transport/gossip.js");
      const match = findCapablePeer(deduped);
      if (!match) return JSON.stringify({ error: `No alive peer with capabilities: [${deduped.join(", ")}]` });
      peer = match.name;
      logDebug(TAG, `Auto-selected peer ${peer} for requires=[${deduped.join(",")}] (load=${match.load})`);
    } else if (!peer) {
      const { getPeerTable } = await import("../peer-transport/gossip.js");
      const alive = getPeerTable().sort((a, b) => a.load - b.load);
      if (alive.length === 0) return JSON.stringify({ error: "No alive peers available" });
      peer = alive[0]!.name;
      logDebug(TAG, `Auto-selected least-loaded peer ${peer} (load=${alive[0]!.load})`);
    }

    // Validate explicit peer against effective capabilities
    if (deduped.length > 0 && args.peer) {
      const { getPeerTable } = await import("../peer-transport/gossip.js");
      const entry = getPeerTable(true).find(p => p.name.toLowerCase() === peer!.toLowerCase());
      if (!entry || !entry.alive) {
        return JSON.stringify({ error: `Peer ${peer} is unknown or stale` });
      }
      if (!deduped.every(r => entry.capabilities.includes(r))) {
        const missing = deduped.filter(r => !entry.capabilities.includes(r));
        return JSON.stringify({ error: `Peer ${peer} lacks capabilities: [${missing.join(", ")}]` });
      }
    }

    logDebug(TAG, `peer_delegate: peer=${peer} kind=${executor ?? "agent"} priority=${priority ?? "MEDIUM"} goal=${goal.length}ch requires=[${deduped.join(",")}]`);
    logTrace(TAG, `peer_delegate goal: ${goal.slice(0, 500)}`);

    const requestId = args.request_id ?? randomUUID();
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128 || !/^[A-Za-z0-9._:\-]+$/.test(requestId)) {
      return JSON.stringify({ error: "request_id must match [A-Za-z0-9._:-]+ and be at most 128 characters" });
    }
    let localCardId: number | undefined;
    try {
      const transport = getPeerTransport();
      const contract = args.worker_contract ? JSON.parse(args.worker_contract) : undefined;
      const existing = kanbanFindRemoteDelegation(peer!, requestId);
      if (existing) {
        let existingNotes: Record<string, unknown> = {};
        try { existingNotes = JSON.parse(existing.notes ?? "{}") as Record<string, unknown>; } catch { return JSON.stringify({ error: `Stored delegation ${requestId} has invalid metadata` }); }
        if (existingNotes.goal !== goal || existingNotes.executor !== (executor ?? "agent") || existingNotes.workspace_alias !== target?.workspace_alias) {
          return JSON.stringify({ error: "request_id used with different payload", reason: "request_id_conflict", request_id: requestId });
        }
        if (typeof existingNotes.remote_task_id === "number") {
          return JSON.stringify({ ok: true, local_card_id: existing.id, remote_task_id: existingNotes.remote_task_id, remote_session_id: existingNotes.remote_session_id, remote_run_id: existingNotes.remote_run_id, remote_generation: existingNotes.remote_generation, executor: existingNotes.executor, peer, status: "queued", duplicate: true, request_id: requestId });
        }
      }
      const pendingNotes: Record<string, unknown> = {
        peer, goal, requires: deduped, executor: executor ?? "agent", request_id: requestId,
        workspace_alias: target?.workspace_alias, outcome: "pending",
      };
      if (target?.model) pendingNotes.model = target.model;
      if (target?.delivery) pendingNotes.delivery = target.delivery;
      localCardId = existing?.id ?? kanbanEnqueue(`[remote:${peer}] ${goal.slice(0, 80)}`, "peer", requestId, {
        type: "remote",
        priority: priority ?? "MEDIUM",
        notes: JSON.stringify(pendingNotes),
        sourcePeer: peer,
      });
      if (!localCardId) return JSON.stringify({ error: "Failed to persist remote delegation", request_id: requestId });
      const result = await transport.delegateTask(peer, goal, {
        priority, context, artifacts, contract,
        attemptId: args.attempt_id,
        target,
        requestId,
      });

      const notes: Record<string, unknown> = {
        peer, remote_task_id: result.taskId, remote_session_id: result.remoteSessionId,
        goal, requires: deduped, executor: executor ?? "agent", request_id: requestId, outcome: "accepted",
      };
      if (result.runId) notes.remote_run_id = result.runId;
      if (result.generation !== undefined) notes.remote_generation = result.generation;
      if (target) {
        notes.workspace_alias = target.workspace_alias;
        if (target.model) notes.model = target.model;
        if (target.delivery) notes.delivery = target.delivery;
      }
      kanbanUpdate(localCardId, { notes: JSON.stringify(notes) });

      if (result.remoteSessionId) {
        const { spin } = await import("../spin.js");
        const { getMasterUserId } = await import("../master-user.js");
        spin.createHollowSession(getMasterUserId(), "telegram", "W", peer, result.remoteSessionId);
      }

      logInfo(TAG, `Delegated to ${peer}: remote#${result.taskId} → local#${localCardId} kind=${result.executor ?? "agent"}`);
      return JSON.stringify({
        ok: true, local_card_id: localCardId, remote_task_id: result.taskId,
        remote_session_id: result.remoteSessionId, remote_run_id: result.runId,
        remote_generation: result.generation, executor: result.executor ?? "agent",
        peer, status: "queued",
        request_id: requestId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `peer_delegate failed: ${message}`);
      return JSON.stringify({ error: `peer_delegate failed: ${message}`, outcome: "unknown", request_id: requestId, local_card_id: localCardId });
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
