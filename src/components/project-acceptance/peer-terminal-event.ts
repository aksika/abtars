import type { ContributionProjectionV1, PeerContributionEventV1 } from "../peer-help/contract.js";
import { kanbanGetCard } from "../tasks/kanban-board.js";
import { loadPeerConfig } from "../peer-config.js";

/**
 * peer-terminal-event.ts — peer-visible terminal event for a settled project.
 *
 * #1630: extracted from project-review-service.ts so the blocked-settlement
 * transaction can auto-derive a failed terminal event when the caller did not
 * supply one (orc-tools invalid-proposal exhaustion, reconciler abandoned
 * review). The builder is module-local here, not exported from the service,
 * so stores and tool handlers can use it without dragging service
 * dependencies into their import graph.
 */

export interface PeerTerminalEvent {
  readonly peer: string;
  readonly payload: PeerContributionEventV1;
}

/**
 * Structural evidence source. `ReviewCaseSnapshot` satisfies this shape, so the
 * service passes its snapshot with no cast and no import of the snapshot type
 * here. Declaring the narrow shape avoids a store → peer-terminal-event →
 * project-review-case → store import cycle.
 */
export interface TerminalEvidenceSource {
  readonly project_card_id: number;
  readonly root_contract?: { readonly id?: string };
  readonly criterion_inputs: ReadonlyArray<{
    readonly observed_evidence_ids: readonly string[];
    readonly artifact_observation_ids: readonly string[];
  }>;
}

export function buildPeerTerminalEvent(input: {
  readonly cardId: number;
  readonly decisionId: string;
  readonly kind: "completed" | "failed";
  readonly summary: string;
  readonly evidenceSource?: TerminalEvidenceSource;
  readonly failureReason?: string;
}): PeerTerminalEvent | undefined {
  try {
    const card = kanbanGetCard(input.cardId);
    if (!card?.source_peer || !card.notes) return undefined;
    const notes = JSON.parse(card.notes) as Record<string, unknown>;
    const requestId = typeof notes.request_id === "string" ? notes.request_id : undefined;
    const contributionRef = typeof notes.contribution_ref === "string" ? notes.contribution_ref : undefined;
    if (!requestId || !contributionRef) return undefined;

    // #1618: the projection's receiver_peer must be the RECEIVER's own logical
    // name (the sender of this event). The requester's reducer compares it
    // against the sender's name as it knows it — card.source_peer is the
    // requester's name and would always mismatch on a real two-node topology.
    let receiverPeer = card.source_peer;
    try {
      receiverPeer = loadPeerConfig().self.name;
    } catch { /* keep source_peer fallback */ }

    const projection = buildTerminalProjection(input, receiverPeer);
    const eventId = `${input.kind === "completed" ? "accept" : "fail"}_${requestId}_${contributionRef}_${input.decisionId.replace(/[^a-zA-Z0-9]/g, "_")}`.slice(0, 128);

    return {
      peer: card.source_peer,
      payload: {
        version: 1,
        event_id: eventId,
        sequence: 0,
        request_id: requestId,
        contribution_ref: contributionRef,
        kind: input.kind,
        occurred_at: new Date().toISOString(),
        summary: effectiveSummary(input.summary).slice(0, 1000),
        projection,
      },
    };
  } catch {
    return undefined;
  }
}

/** A terminal projection summary must never be empty (contract rejects zero-length). */
function effectiveSummary(summary: string): string {
  return summary.trim().length === 0 ? "Project blocked" : summary;
}

function buildTerminalProjection(input: {
  readonly cardId: number;
  readonly decisionId: string;
  readonly kind: "completed" | "failed";
  readonly summary: string;
  readonly evidenceSource?: TerminalEvidenceSource;
  readonly failureReason?: string;
}, receiverPeer: string): ContributionProjectionV1 {
  const MAX_EVIDENCE_ITEMS = 20;
  const MAX_EVIDENCE_ID_LENGTH = 128;
  const evidence: Array<{ id: string; kind: string; summary: string; observed_by: string }> = [];
  const source = input.evidenceSource;
  if (source && input.kind === "completed") {
    for (const ci of source.criterion_inputs) {
      for (const eid of ci.observed_evidence_ids.slice(0, MAX_EVIDENCE_ITEMS)) {
        evidence.push({ id: eid.slice(0, MAX_EVIDENCE_ID_LENGTH), kind: "check", summary: "observed", observed_by: receiverPeer.slice(0, 64) });
      }
      for (const eid of ci.artifact_observation_ids.slice(0, MAX_EVIDENCE_ITEMS)) {
        evidence.push({ id: eid.slice(0, MAX_EVIDENCE_ID_LENGTH), kind: "artifact", summary: "present", observed_by: receiverPeer.slice(0, 64) });
      }
    }
  }
  const failureSuffix = input.kind === "failed" && input.failureReason ? `\nReason: ${input.failureReason}` : "";
  return {
    schema_version: 1,
    outcome: input.kind,
    summary: (effectiveSummary(input.summary) + failureSuffix).slice(0, 1000),
    evidence: evidence.slice(0, MAX_EVIDENCE_ITEMS),
    artifacts: [],
    provenance: {
      receiver_peer: receiverPeer,
      receiver_project_ref: source?.root_contract?.id?.slice(0, 128) ?? `project_${input.cardId}`,
      acceptance_id: input.decisionId,
      accepted_at: new Date().toISOString(),
    },
  };
}
