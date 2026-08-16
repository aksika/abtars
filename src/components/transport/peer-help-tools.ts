import type { ToolDefinition } from "./tool-registry.js";
import type { PeerHelpRequestV1 } from "../peer-help/contract.js";
import { ContributionStore } from "../peer-help/contribution-store.js";
import { RequesterContributionService } from "../peer-help/requester-contribution-service.js";
import { getPeerTransport } from "../peer-transport/index.js";
import { kanbanUpdate, kanbanFail, kanbanGetCard, requireTaskDatabase } from "../tasks/kanban-board.js";
import { logInfo, logWarn, logDebug } from "../logger.js";
import { randomUUID } from "node:crypto";

const TAG = "peer-help";

function parseStringArray(value: unknown, field: string): string[] {
  let parsed: unknown = value;
  if (typeof value === "string") parsed = JSON.parse(value);
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed) || parsed.some(v => typeof v !== "string" || v.length === 0 || v.length > 128)) {
    throw new Error(`${field} must be an array of non-empty strings at most 128 characters long`);
  }
  return [...new Set(parsed)].slice(0, 50);
}

async function resolveEnrolledPeers(names: string[]): Promise<string[]> {
  const { resolvePeerName } = await import("./peer-resolver.js");
  const resolved: string[] = [];
  for (const name of names) {
    const result = resolvePeerName(name);
    if (result.ok) resolved.push(result.peer);
  }
  return [...new Set(resolved)];
}

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
  async execute(args: Record<string, string>, toolContext): Promise<string> {
    const { isActiveCardPeerSourced } = await import("./orc-tools.js");
    if (await isActiveCardPeerSourced(toolContext)) {
      return JSON.stringify({ error: "Relaying to other peers is not permitted for peer-originated requests. Peers communicate directly.", reason: "peer_relay_blocked" });
    }

    const { goal, priority, context: requestContext, executor } = args;
    let peer = args.peer;
    let requires: string[];
    let rootCriteria: string[];
    try {
      requires = parseStringArray(args.requires, "requires");
      rootCriteria = parseStringArray(args.root_criteria, "root_criteria");
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }

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
      const candidates = await resolveEnrolledPeers(connected.filter(p => deduped.length === 0 || hasAllCapabilities(p, deduped)));
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
      const enrolled = await resolveEnrolledPeers(connected);
      if (enrolled.length === 0) {
        return JSON.stringify({ error: "No connected peers available" });
      }
      enrolled.sort((a, b) => a.localeCompare(b));
      peer = enrolled[0]!;
    }

    const { resolvePeerName } = await import("./peer-resolver.js");
    const resolvedPeer = resolvePeerName(peer);
    if (!resolvedPeer.ok) return JSON.stringify({ error: resolvedPeer.message, code: resolvedPeer.code });
    peer = resolvedPeer.peer;

    if (!peer) {
      return JSON.stringify({ error: "No peer specified and none auto-selected" });
    }

    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const request: PeerHelpRequestV1 = {
      version: 1,
      request_id: requestId,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      goal,
      context: requestContext,
      priority: (priority as any) ?? "MEDIUM",
      required_capabilities: deduped,
      target,
    };

    let localCardId: number | undefined;
    let activeContributionPeer: string | undefined;
    let activeContributionRequestId: string | undefined;
    const attempts: Array<{ peer: string; request_id: string; outcome: string; code?: string }> = [];
    try {
      const activeOrc = await getActiveOrcProjectId(toolContext);
      if (rootCriteria.length > 0) {
        if (!activeOrc) return JSON.stringify({ error: "root_criteria requires an active Orc project" });
        const { ProjectReviewStore } = await import("../project-acceptance/project-review-store.js");
        const contractRow = new ProjectReviewStore().getContractByProjectCardId(activeOrc);
        if (!contractRow) return JSON.stringify({ error: `active Orc project #${activeOrc} has no root acceptance contract` });
        const contract = JSON.parse(contractRow.contract_json) as { criteria?: Array<{ id?: string }> };
        const valid = new Set((contract.criteria ?? []).map(c => c.id).filter((id): id is string => typeof id === "string"));
        const invalid = rootCriteria.filter(id => !valid.has(id));
        if (invalid.length > 0) return JSON.stringify({ error: `root_criteria not found in project #${activeOrc}: ${invalid.join(", ")}` });
      }

      const contributionService = new RequesterContributionService({
        contributionStore: getContributionStore(),
        askHelp: (selectedPeer, selectedRequest) => getPeerTransport().askHelp(selectedPeer, selectedRequest),
        kanbanUpdate,
        kanbanFail,
      });

      // #1357/#1433: Automatic selection may advance only across candidates
      // that return a proven pre-creation decline; each attempt carries a NEW
      // request ID; the caller's intent holds exactly ONE local card. Explicit
      // peers and generic (no-requires) auto-selection are single-candidate
      // selections.
      const autoAdvance = !args.peer && deduped.length > 0;
      const candidates: string[] = autoAdvance
        ? await (async () => {
            const { getPeerWsBroker } = await import("../peer-transport/peer-ws-broker.js");
            const { hasAllCapabilities } = await import("../peer-transport/peer-inventory.js");
            const connected = getPeerWsBroker().getConnectedPeers();
            const eligible = await resolveEnrolledPeers(connected.filter(p => hasAllCapabilities(p, deduped)));
            eligible.sort((a, b) => a.localeCompare(b));
            return eligible;
          })()
        : [peer];

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]!;
        const attemptRequestId = i === 0 ? requestId : randomUUID();
        const attemptRequest: PeerHelpRequestV1 = { ...request, request_id: attemptRequestId };

        const result = await contributionService.delegate({
          peer: candidate,
          request: attemptRequest,
          binding: { kind: "existing", projectCardId: activeOrc, rootCriteria },
          proxyCardId: localCardId,
          // Keep the proxy reusable while candidates remain; the final attempt
          // settles the card.
          terminalizeNonStarted: !autoAdvance || i === candidates.length - 1 ? undefined : false,
        });
        localCardId = result.proxyCardId;
        activeContributionPeer = candidate;
        activeContributionRequestId = attemptRequestId;
        if (!localCardId) return JSON.stringify({ error: "Failed to persist help request", request_id: attemptRequestId });

        attempts.push({
          peer: candidate,
          request_id: attemptRequestId,
          outcome: result.decision,
          code: result.response?.reason_code,
        });
        await recordAttempt(localCardId, attempts);

        if (result.decision === "accepted") {
          const response = result.response;
          return JSON.stringify({
            ok: true, local_card_id: localCardId, peer: candidate, decision: "accepted",
            contribution_ref: result.contributionRef, request_id: attemptRequestId,
            remote_run_id: response?.remote_run_id,
            remote_card_id: response?.remote_card_id,
            remote_generation: response?.remote_generation,
            remote_session_id: response?.remote_session_id,
          });
        }

        if (result.decision === "unknown") {
          // Freeze on this peer: an unknown outcome (timeout, drop, or a
          // declined response without proves_non_creation) never advances.
          // The caller reconciles the SAME (peer, request_id).
          return JSON.stringify({
            error: result.error ? `peer_ask_help failed: ${result.error}` : "peer_ask_help outcome unknown",
            outcome: "unknown",
            request_id: attemptRequestId,
            local_card_id: localCardId,
            peer: candidate,
          });
        }

        if (result.decision === "deferred") {
          // Deferred is an acceptance: the request stays bound to this peer.
          // No further candidate is contacted.
          return JSON.stringify({
            ok: true, local_card_id: localCardId, peer: candidate, decision: "deferred",
            reason_code: result.response?.reason_code, reason: result.response?.reason,
            request_id: attemptRequestId,
          });
        }

        // decision === "declined" here, and delegate() degrades an unproven
        // decline to "unknown" — so this is a proven pre-creation decline.
        if (!autoAdvance || i === candidates.length - 1) {
          if (autoAdvance) {
            // Candidate exhaustion: one bounded routing error naming every
            // attempted peer and its reason. No run was created anywhere.
            const details = attempts.map(a => `${a.peer}(${a.code ?? a.outcome})`).join(", ");
            return JSON.stringify({
              error: `No eligible peer accepted the request. Attempted: ${details}`,
              outcome: "exhausted",
              attempts,
              local_card_id: localCardId,
            });
          }
          // Explicit peer: a decline is terminal on that peer.
          return JSON.stringify({
            ok: true, local_card_id: localCardId, peer: candidate, decision: "declined",
            reason_code: result.response?.reason_code, reason: result.response?.reason,
            request_id: attemptRequestId,
          });
        }

        // Proven pre-creation decline on an auto-selected candidate with
        // candidates remaining: release the proxy binding from this peer and
        // advance to the next candidate with a NEW request ID.
        getContributionStore().detachProxy(candidate, attemptRequestId);
      }

      return JSON.stringify({ error: "peer_ask_help failed: no candidate attempted", outcome: "exhausted", attempts, local_card_id: localCardId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (localCardId) {
        try {
          const store = getContributionStore();
          if (activeContributionPeer) store.transitionToNonStarted(activeContributionPeer, activeContributionRequestId ?? requestId, "unknown");
          const card = kanbanGetCard(localCardId);
          const notes = (card?.notes ? JSON.parse(card.notes) : {}) as Record<string, unknown>;
          const priorAttempts = Array.isArray(notes.attempts) ? notes.attempts : [];
          kanbanUpdate(localCardId, { notes: JSON.stringify({ ...notes, outcome: "unknown", request_id: activeContributionRequestId ?? requestId, attempts: priorAttempts }) });
        } catch {}
      }
      logWarn(TAG, `peer_ask_help failed: ${message}`);
      return JSON.stringify({ error: `peer_ask_help failed: ${message}`, outcome: "unknown", request_id: activeContributionRequestId ?? requestId, local_card_id: localCardId });
    }
  },
};

/** #1357: persist the attempt history on the single delegation card. */
async function recordAttempt(cardId: number, history: Array<{ peer: string; request_id: string; outcome: string; code?: string }>): Promise<void> {
  try {
    const card = kanbanGetCard(cardId);
    const notes = (card?.notes ? JSON.parse(card.notes) : {}) as Record<string, unknown>;
    notes.attempts = history.slice(-10);
    kanbanUpdate(cardId, { notes: JSON.stringify(notes) });
  } catch { /* best effort — the ledger row is authoritative */ }
}

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
      const { resolvePeerName } = await import("./peer-resolver.js");
      const resolved = resolvePeerName(peer);
      if (!resolved.ok) return JSON.stringify({ error: resolved.message, code: resolved.code });
      const transport = getPeerTransport();
      const result = await transport.getHelpStatus(resolved.peer, { version: 1, request_id: requestId, contribution_ref: contributionRef });
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
      const { resolvePeerName } = await import("./peer-resolver.js");
      const resolved = resolvePeerName(peer);
      if (!resolved.ok) return JSON.stringify({ error: resolved.message, code: resolved.code });
      const transport = getPeerTransport();
      const result = await transport.withdrawHelp(resolved.peer, {
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

async function getActiveOrcProjectId(toolContext?: { orcContext?: { projectCardId: number } }): Promise<number | null> {
  return toolContext?.orcContext?.projectCardId ?? null;
}

export function getPeerHelpTools(): ToolDefinition[] {
  return [peerAskHelpTool, peerHelpStatusTool, peerWithdrawHelpTool];
}
