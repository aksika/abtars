import type { PeerHelpRequestV1, PeerHelpResponseV1, HelpDecision } from "./contract.js";
import { parseHelpRequest, canonicalRequestHash, generateContributionRef } from "./contract.js";
import { PeerHelpStore } from "./store.js";
import { logInfo, logWarn, logDebug } from "../logger.js";
import { loadPeerConfig } from "../peer-config.js";

const TAG = "peer-help";

export const MAX_PEER_HELP_PROJECTS = 5;

export interface PeerHelpAdmissionPolicy {
  decide(input: {
    originPeer: string;
    trust: number;
    request: PeerHelpRequestV1;
    localCapabilities: ReadonlySet<string>;
    activePeerProjects: number;
  }): "accept" | "decline" | "defer" | "ignore";
}

export type PeerHelpHandler = (originPeer: string, request: PeerHelpRequestV1, admission: { decision: "accept"; contributionRef: string }) => Promise<{ ok: boolean; runId?: string; error?: string }>;

const builtinPolicy: PeerHelpAdmissionPolicy = {
  decide(input) {
    if (input.trust <= 0) return "ignore";
    if (new Date(input.request.expires_at) <= new Date()) return "decline";

    if (input.request.required_capabilities.length > 0) {
      for (const cap of input.request.required_capabilities) {
        if (!input.localCapabilities.has(cap)) {
          logDebug(TAG, `Declining ${input.request.request_id} from ${input.originPeer}: missing capability ${cap}`);
          return "decline";
        }
      }
    }

    if (input.request.target?.executor === "pi") {
      if (!input.localCapabilities.has("pi-executor")) return "decline";
      if (input.request.target.workspace_alias) {
        const wsCap = `workspace:${input.request.target.workspace_alias}`;
        if (!input.localCapabilities.has(wsCap)) return "decline";
      }
    }

    if (input.activePeerProjects >= MAX_PEER_HELP_PROJECTS) {
      logDebug(TAG, `Deferring ${input.request.request_id} from ${input.originPeer}: queue full (${input.activePeerProjects}/${MAX_PEER_HELP_PROJECTS})`);
      return "defer";
    }

    return "accept";
  },
};

export class PeerHelpService {
  private store: PeerHelpStore;
  private policy: PeerHelpAdmissionPolicy;
  private capabilityRegistry: () => string[];
  private piHandler: PeerHelpHandler | null = null;

  constructor(
    store: PeerHelpStore,
    capabilityRegistry: () => string[],
    policy?: PeerHelpAdmissionPolicy,
  ) {
    this.store = store;
    this.capabilityRegistry = capabilityRegistry;
    this.policy = policy ?? builtinPolicy;
  }

  setPiHandler(handler: PeerHelpHandler): void {
    this.piHandler = handler;
  }

  getStore(): PeerHelpStore {
    return this.store;
  }

  async handleHelpRequest(originPeer: string, raw: unknown): Promise<PeerHelpResponseV1> {
    const parsed = parseHelpRequest(raw);
    if (!parsed.ok) {
      logWarn(TAG, `Malformed help request from ${originPeer}: ${parsed.error}`);
      return { version: 1, request_id: "unknown", decision: "declined", reason_code: "malformed", reason: parsed.error };
    }

    const request = parsed.value;
    const config = loadPeerConfig();
    const peerEntry = config.peers[originPeer];
    const trust = peerEntry?.trust ?? 0;

    const requestHash = canonicalRequestHash(request);

    const reservation = this.store.reserve(originPeer, request.request_id, requestHash);
    if (!reservation.ok) {
      return { version: 1, request_id: request.request_id, decision: "declined", reason_code: "reserve_failed" };
    }

    if (reservation.existing) {
      return reservation.existing.response;
    }

    const localCapabilities = new Set(this.capabilityRegistry().map(c => c.toLowerCase()));
    const activePeerProjects = this.countActivePeerProjects();

    const policyDecision = this.policy.decide({
      originPeer,
      trust,
      request,
      localCapabilities,
      activePeerProjects,
    });

    if (policyDecision !== "accept") {
      const decision = policyDecision === "defer" ? "deferred" as HelpDecision : "declined" as HelpDecision;
      const response: PeerHelpResponseV1 = {
        version: 1,
        request_id: request.request_id,
        decision,
        reason_code: decision === "deferred" ? "queue_full" : "policy_denied",
        reason: decision === "deferred" ? "Queue capacity reached" : "Request declined by local policy",
        retry_after: decision === "deferred" ? new Date(Date.now() + 60_000).toISOString() : undefined,
      };
      this.store.completeDecision(
        { originPeer, requestId: request.request_id },
        decision,
        response,
      );
      return response;
    }

    const contributionRef = generateContributionRef();
    const response: PeerHelpResponseV1 = {
      version: 1,
      request_id: request.request_id,
      decision: "accepted",
      contribution_ref: contributionRef,
    };

    if (request.target?.executor === "pi" && this.piHandler) {
      const piResult = await this.piHandler(originPeer, request, { decision: "accept", contributionRef });
      if (!piResult.ok) {
        this.store.markUnknown(originPeer, request.request_id);
        return {
          version: 1,
          request_id: request.request_id,
          decision: "declined",
          reason_code: "pi_execution_failed",
          reason: piResult.error ?? "Pi execution setup failed",
        };
      }
      this.store.acceptPi(
        { originPeer, requestId: request.request_id, requestHash },
        piResult.runId ?? "",
        response,
      );
    } else {
      const boundedGoal = request.goal.slice(0, 100_000);
      const boundedContext = request.context ? request.context.slice(0, 50_000) : "";
      const combinedGoal = boundedContext
        ? `${boundedGoal}\n\nContext: ${boundedContext}`
        : boundedGoal;

      this.store.acceptGeneric(
        { originPeer, requestId: request.request_id, requestHash },
        {
          goal: combinedGoal,
          title: `[help:${originPeer}] ${request.goal.slice(0, 60)}`,
          sourcePeer: originPeer,
          sourceId: request.request_id,
          deliveryMode: "silent",
          priority: request.priority,
        },
        response,
      );
    }

    logInfo(TAG, `Accepted help request ${request.request_id} from ${originPeer}: ref=${contributionRef}`);
    return response;
  }

  async handleHelpStatus(originPeer: string, raw: unknown): Promise<import("./contract.js").PeerHelpStatusV1 | { version: 1; error: string }> {
    const { parseHelpStatusRequest } = await import("./contract.js");
    const parsed = parseHelpStatusRequest(raw);
    if (!parsed.ok) {
      return { version: 1, error: parsed.error };
    }

    const status = this.store.getPublicStatus(originPeer, parsed.value.request_id, parsed.value.contribution_ref);
    if (!status) {
      return { version: 1, error: "contribution not found" };
    }

    return status;
  }

  async handleHelpWithdraw(originPeer: string, raw: unknown): Promise<{ acknowledged: boolean; owner_action?: string }> {
    const { parseHelpWithdraw } = await import("./contract.js");
    const parsed = parseHelpWithdraw(raw);
    if (!parsed.ok) {
      return { acknowledged: false, owner_action: "malformed" };
    }

    const result = this.store.recordWithdrawal(originPeer, parsed.value.request_id, parsed.value.contribution_ref);
    return {
      acknowledged: result.status === "noted",
      owner_action: result.status,
    };
  }

  async handleContributionEvent(originPeer: string, raw: unknown): Promise<{ ok: boolean }> {
    const { parseContributionEvent } = await import("./contract.js");
    const parsed = parseContributionEvent(raw);
    if (!parsed.ok) {
      return { ok: false };
    }

    const event = parsed.value;
    this.store.recordContributionEvent(originPeer, event.request_id, event.contribution_ref, event.kind === "completed" ? "completed" : event.kind === "failed" ? "failed" : "running");
    return { ok: true };
  }

  private countActivePeerProjects(): number {
    const { kanbanList } = require("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
    const running = kanbanList("running", "status").filter(c => {
      if (c.type !== "O") return false;
      try {
        const notes = JSON.parse(c.notes ?? "{}");
        return notes.origin_peer && notes.help_decision === "accepted";
      } catch { return false; }
    });
    const queued = kanbanList("queued", "status").filter(c => {
      if (c.type !== "O") return false;
      try {
        const notes = JSON.parse(c.notes ?? "{}");
        return notes.origin_peer && notes.help_decision === "accepted";
      } catch { return false; }
    });
    return running.length + queued.length;
  }
}
