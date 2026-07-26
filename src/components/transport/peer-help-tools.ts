import type { ToolDefinition } from "./tool-registry.js";
import type { PeerHelpRequestV1 } from "../peer-help/contract.js";
import { canonicalRequestHash } from "../peer-help/contract.js";
import { ContributionStore } from "../peer-help/contribution-store.js";
import { getPeerTransport } from "../peer-transport/index.js";
import { kanbanEnqueue, kanbanRunning, kanbanUpdate, kanbanGetCard, requireTaskDatabase } from "../tasks/kanban-board.js";
import { logInfo, logWarn, logDebug } from "../logger.js";
import { randomUUID } from "node:crypto";

const TAG = "peer-help";

export const peerAskHelpTool: ToolDefinition = {
  name: "peer_ask_help",
  description: "Ask a remote peer for help with a task. If peer is omitted, auto-selects an enrolled peer whose inventory matches required capabilities. The receiving peer independently decides whether to accept, decline, or defer.",
  parameters: {
    type: "object",
    properties: {
      peer: { type: "string", description: "Peer name (optional — auto-selects if omitted)" },
      goal: { type: "string", description: "Goal/instructions for the remote peer" },
      priority: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"], description: "Priority hint (receiver decides order locally)" },
      context: { type: "string", description: "Optional context to include" },
      requires: { type: "array", items: { type: "string" }, description: "Required capabilities (e.g. ['corporate-network'])" },
      root_criteria: { type: "array", items: { type: "string" }, description: "Root criterion IDs this contribution is expected to cover (linked to active Orc project)" },
      executor: { type: "string", enum: ["agent", "pi"], description: "Execution target type. 'pi' for coding delegation (#1357)" },
      workspace_alias: { type: "string", description: "Peer-local workspace alias (required when executor='pi')" },
      model: { type: "string", description: "JSON object {provider, model_id, thinking?} for Pi execution" },
      delivery: { type: "string", enum: ["commit_push", "patch_artifact", "leave_remote"], description: "Delivery policy for Pi results" },
      request_id: { type: "string", description: "Stable request ID for safe replay after unknown outcomes" },
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
    const rootCriteria: string[] = args.root_criteria ? (typeof args.root_criteria === "string" ? JSON.parse(args.root_criteria) : args.root_criteria) : [];

    if (!goal) return JSON.stringify({ error: "goal is required" });

    const requestId = args.request_id ?? randomUUID();
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128 || !/^[A-Za-z0-9._:\-]+$/.test(requestId)) {
      return JSON.stringify({ error: "request_id must match [A-Za-z0-9._:-]+ and be at most 128 characters" });
    }

    const effectiveRequires = [...requires];
    let target: PeerHelpRequestV1["target"] | undefined;
    if (executor === "pi") {
      const workspaceAlias = args.workspace_alias;
      if (!workspaceAlias || typeof workspaceAlias !== "string") {
        return JSON.stringify({ error: "workspace_alias is required when executor='pi'" });
      }
      if (!/^[a-z][a-z0-9_.\-]{0,63}$/.test(workspaceAlias)) {
        return JSON.stringify({ error: `Invalid workspace_alias "${workspaceAlias}"` });
      }
      target = { executor: "pi", workspace_alias: workspaceAlias };
      if (args.model) {
        try {
          const m = typeof args.model === "string" ? JSON.parse(args.model) : args.model;
          if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.provider !== "string" || !m.provider ||
              typeof m.model_id !== "string" || !m.model_id || (m.thinking !== undefined && typeof m.thinking !== "string")) {
            return JSON.stringify({ error: "model must be valid JSON {provider, model_id, thinking?}" });
          }
          target.model = { provider: m.provider, model_id: m.model_id, thinking: m.thinking };
        } catch { return JSON.stringify({ error: "model must be valid JSON {provider, model_id, thinking?}" }); }
      }
      if (args.delivery) {
        if (!["commit_push", "patch_artifact", "leave_remote"].includes(args.delivery)) {
          return JSON.stringify({ error: "delivery must be commit_push, patch_artifact, or leave_remote" });
        }
        target.delivery = args.delivery as "commit_push" | "patch_artifact" | "leave_remote";
      }
      effectiveRequires.push("pi-executor", `workspace:${workspaceAlias}`);
    }

    const deduped = [...new Set(effectiveRequires)].sort();

    if (!peer && deduped.length > 0) {
      const { getPeerWsBroker } = await import("../peer-transport/peer-ws-broker.js");
      const { hasAllCapabilities } = await import("../peer-transport/peer-inventory.js");
      const connected = getPeerWsBroker().getConnectedPeers();
      const candidates = connected.filter(p => deduped.length === 0 || hasAllCapabilities(p, deduped));
      if (candidates.length === 0) {
        return JSON.stringify({ error: `No connected peer with capabilities: [${deduped.join(", ")}]` });
      }
      // #1357/#1433: Static inventory is a capability hint only. Candidate
      // order is deterministic; receiver admission remains authoritative.
      candidates.sort((a, b) => a.localeCompare(b));
      peer = candidates[0]!;
      logDebug(TAG, `Auto-selected peer ${peer} for requires=[${deduped.join(",")}]`);
    } else if (!peer) {
      const { getPeerWsBroker } = await import("../peer-transport/peer-ws-broker.js");
      const connected = getPeerWsBroker().getConnectedPeers();
      if (connected.length === 0) {
        return JSON.stringify({ error: "No connected peers available" });
      }
      connected.sort((a, b) => a.localeCompare(b));
      peer = connected[0]!;
    }

    // #1433/#1357: An explicit peer with no inventory may still be asked over a
    // live route; receiver admission is authoritative. Contradictory inventory
    // is an early rejection, never a fallback to another peer.
    if (peer && deduped.length > 0) {
      const { getPeerInventory, hasAllCapabilities } = await import("../peer-transport/peer-inventory.js");
      if (getPeerInventory(peer) && !hasAllCapabilities(peer, deduped)) {
        return JSON.stringify({ error: `Peer ${peer} does not have the required capabilities: [${deduped.join(", ")}]` });
      }
    }

    if (!peer) {
      return JSON.stringify({ error: "No peer specified and none auto-selected" });
    }

    const transport = getPeerTransport();
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const request: PeerHelpRequestV1 = {
      version: 1,
      request_id: requestId,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      goal,
      context,
      priority: (priority as any) ?? "MEDIUM",
      required_capabilities: deduped,
      target,
    };

    let localCardId: number | undefined;
    try {
      const activeOrc = await getActiveOrcProjectId();

      const requestHash = canonicalRequestHash(request);
      const contributionStore = getContributionStore();

      const rootCriteriaJson = rootCriteria.length > 0 ? JSON.stringify(rootCriteria) : null;
      const reserveResult = contributionStore.reserve(peer, requestId, requestHash, activeOrc, null, rootCriteriaJson);
      if (reserveResult.status === "conflict") {
        return JSON.stringify({ error: `Request ${requestId} to ${peer} conflicts with an existing contribution with different parameters` });
      }
      const contributionRef = reserveResult.contributionRef ?? `help_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

      const pendingNotes = { peer, goal, requires: deduped, executor: executor ?? "agent", request_id: requestId, outcome: "pending", contribution_ref: contributionRef };
      localCardId = kanbanEnqueue(`[help:${peer}] ${goal.slice(0, 80)}`, "peer", requestId, {
        type: "contribution",
        priority: priority ?? "MEDIUM",
        notes: JSON.stringify(pendingNotes),
        sourcePeer: peer,
        parent_id: activeOrc ?? undefined,
      });
      if (!localCardId) return JSON.stringify({ error: "Failed to persist help request", request_id: requestId });
      kanbanRunning(localCardId);

      const response = await transport.askHelp(peer, request);

      if (response.decision === "accepted") {
        contributionStore.transitionToAccepted(peer, requestId);
        const notes: Record<string, unknown> = {
          peer, goal, requires: deduped, executor: executor ?? "agent", request_id: requestId,
          outcome: "accepted", contribution_ref: response.contribution_ref ?? contributionRef,
        };
        if (response.remote_run_id) notes.remote_run_id = response.remote_run_id;
        if (response.remote_card_id !== undefined) notes.remote_card_id = response.remote_card_id;
        if (response.remote_generation !== undefined) notes.remote_generation = response.remote_generation;
        if (response.remote_session_id) notes.remote_session_id = response.remote_session_id;
        kanbanUpdate(localCardId, { notes: JSON.stringify(notes) });
        logInfo(TAG, `Help accepted by ${peer}: ref=${response.contribution_ref ?? contributionRef}`);
        return JSON.stringify({
          ok: true, local_card_id: localCardId, peer, decision: "accepted",
          contribution_ref: response.contribution_ref ?? contributionRef, request_id: requestId,
          remote_run_id: response.remote_run_id,
          remote_card_id: response.remote_card_id,
          remote_generation: response.remote_generation,
          remote_session_id: response.remote_session_id,
        });
      }

      contributionStore.transitionToNonStarted(peer, requestId, response.decision as any);
      const notes = { peer, goal, requires: deduped, executor: executor ?? "agent", request_id: requestId, outcome: response.decision };
      kanbanUpdate(localCardId, { notes: JSON.stringify(notes) });
      logInfo(TAG, `Help ${response.decision} by ${peer}${response.reason ? `: ${response.reason}` : ""}`);

      if (response.decision === "declined" && !args.peer && deduped.length > 0) {
        const { getPeerWsBroker } = await import("../peer-transport/peer-ws-broker.js");
        const { hasAllCapabilities } = await import("../peer-transport/peer-inventory.js");
        const connected = getPeerWsBroker().getConnectedPeers().filter(p => p !== peer);
        const eligible = connected.filter(p => deduped.length === 0 || hasAllCapabilities(p, deduped));
        eligible.sort((a, b) => a.localeCompare(b));
        const nextCandidate = eligible[0];
        if (nextCandidate) {
          const newRequestId = randomUUID();
          const fallbackRequest: PeerHelpRequestV1 = { ...request, request_id: newRequestId };
          const fallbackResponse = await transport.askHelp(nextCandidate, fallbackRequest);
          const fallbackNotes = { peer: nextCandidate, goal, requires: deduped, executor: executor ?? "agent", request_id: newRequestId, outcome: fallbackResponse.decision };
          if (fallbackResponse.decision === "accepted") {
            Object.assign(fallbackNotes, { contribution_ref: fallbackResponse.contribution_ref });
            kanbanUpdate(localCardId, { notes: JSON.stringify(fallbackNotes) });
            return JSON.stringify({
              ok: true, local_card_id: localCardId, peer: nextCandidate, decision: "accepted",
              contribution_ref: fallbackResponse.contribution_ref, request_id: newRequestId,
              fallback: true,
            });
          }
          kanbanUpdate(localCardId, { notes: JSON.stringify(fallbackNotes) });
        }
      }

      return JSON.stringify({
        ok: true, local_card_id: localCardId, peer, decision: response.decision,
        reason_code: response.reason_code, reason: response.reason, request_id: requestId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `peer_ask_help failed: ${message}`);
      return JSON.stringify({ error: `peer_ask_help failed: ${message}`, outcome: "unknown", request_id: requestId, local_card_id: localCardId });
    }
  },
};

export const peerHelpStatusTool: ToolDefinition = {
  name: "peer_help_status",
  description: "Check the status of a help request sent to a remote peer. Returns the current contribution state without claiming remote ownership.",
  parameters: {
    type: "object",
    properties: {
      peer: { type: "string", description: "Peer name" },
      request_id: { type: "string", description: "Request ID from peer_ask_help result" },
      contribution_ref: { type: "string", description: "Contribution reference (from accepted response)" },
    },
    required: ["peer", "request_id", "contribution_ref"],
  },
  async execute(args: Record<string, string>): Promise<string> {
    const peer = args.peer;
    const requestId = args.request_id;
    const contributionRef = args.contribution_ref;
    if (!peer || !requestId || !contributionRef) return JSON.stringify({ error: "peer, request_id, and contribution_ref are required" });

    try {
      const transport = getPeerTransport();
      const result = await transport.getHelpStatus(peer, { version: 1, request_id: requestId, contribution_ref: contributionRef });
      return JSON.stringify({ ok: true, ...result });
    } catch (err) {
      logWarn(TAG, `peer_help_status failed: ${err instanceof Error ? err.message : String(err)}`);
      return JSON.stringify({ error: `peer_help_status failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  },
};

export const peerWithdrawHelpTool: ToolDefinition = {
  name: "peer_withdraw_help",
  description: "Notify a peer that a help request is withdrawn. This is informational — the receiver independently decides whether to continue, stop, or keep its local work.",
  parameters: {
    type: "object",
    properties: {
      peer: { type: "string", description: "Peer name" },
      request_id: { type: "string", description: "Request ID from peer_ask_help" },
      contribution_ref: { type: "string", description: "Contribution reference from accepted response" },
      reason: { type: "string", description: "Optional reason for withdrawal" },
    },
    required: ["peer", "request_id", "contribution_ref"],
  },
  async execute(args: Record<string, string>): Promise<string> {
    const peer = args.peer;
    const requestId = args.request_id;
    const contributionRef = args.contribution_ref;
    if (!peer || !requestId || !contributionRef) return JSON.stringify({ error: "peer, request_id, and contribution_ref are required" });

    try {
      const transport = getPeerTransport();
      const result = await transport.withdrawHelp(peer, {
        version: 1,
        request_id: requestId,
        contribution_ref: contributionRef,
        reason: args.reason,
      });
      logInfo(TAG, `Withdrawn help request ${requestId} from ${peer}: ${result.owner_action}`);
      return JSON.stringify({ ok: true, ...result });
    } catch (err) {
      logWarn(TAG, `peer_withdraw_help failed: ${err instanceof Error ? err.message : String(err)}`);
      return JSON.stringify({ error: `peer_withdraw_help failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  },
};

let _contributionDb: any = null;
function getContributionStore(): ContributionStore {
  if (!_contributionDb) {
    const db = requireTaskDatabase();
    _contributionDb = new ContributionStore(db, {
      kanbanGetCard: (id: number) => kanbanGetCard(id) ?? undefined,
      kanbanUpdate,
      kanbanComplete: () => {},
      kanbanFail: () => {},
    });
  }
  return _contributionDb;
}

async function getActiveOrcProjectId(): Promise<number | null> {
  try {
    const { getActiveOrcCard } = await import("./orc-tools.js");
    return getActiveOrcCard();
  } catch { return null; }
}

export function getPeerHelpTools(): ToolDefinition[] {
  return [peerAskHelpTool, peerHelpStatusTool, peerWithdrawHelpTool];
}
