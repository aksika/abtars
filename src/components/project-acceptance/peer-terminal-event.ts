import type { ContributionProjectionV1, PeerContributionEventV1 } from "../peer-help/contract.js";
import type { PeerTerminalIdentity } from "../peer-help/store.js";

/**
 * peer-terminal-event.ts — peer-visible terminal event for a settled project.
 *
 * #1630: extracted from project-review-service.ts so the blocked-settlement
 * transaction can auto-derive a failed terminal event when the caller did not
 * supply one (orc-tools invalid-proposal exhaustion, reconciler abandoned
 * review). The builder is module-local here, not exported from the service,
 * so stores and tool handlers can use it without dragging service
 * dependencies into their import graph.
 *
 * #1680: the builder is PURE. It accepts explicit durable correlation identity
 * and the receiver's own peer name; it performs no database, card-note,
 * transport, or mutable-state read. Correlation authority lives in the
 * accepted `peer_help_requests` ledger (see `readPeerTerminalIdentity`), never
 * in card notes.
 */

export interface PeerTerminalEvent {
  readonly peer: string;
  readonly payload: PeerContributionEventV1;
}

/**
 * #1680: a terminal event recipe. Callers describe WHAT to derive (kind,
 * summary, bounded evidence source, optional failure reason); the settlement
 * transaction resolves the durable correlation identity and builds the event.
 * This replaces caller-supplied, note-derived event objects so every accepted
 * and blocked path settles through one resolver.
 */
export interface PeerTerminalRecipe {
  readonly kind: "completed" | "failed";
  readonly summary: string;
  readonly evidenceSource?: TerminalEvidenceSource;
  readonly failureReason?: string;
}

/**
 * #1680: durable correlation inputs. Every terminal event is built from the
 * accepted help ledger identity plus the receiver's own logical name — never
 * from mutable card notes.
 */
export interface BuildPeerTerminalEventInput {
  readonly cardId: number;
  readonly decisionId: string;
  readonly kind: "completed" | "failed";
  readonly summary: string;
  readonly receiverPeer: string;
  readonly identity: PeerTerminalIdentity;
  readonly evidenceSource?: TerminalEvidenceSource;
  readonly failureReason?: string;
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

export function buildPeerTerminalEvent(input: BuildPeerTerminalEventInput): PeerTerminalEvent {
  // #1680: the projection's receiver_peer is the RECEIVER's own logical name
  // (the sender of this event). The requester's reducer compares it against
  // the sender's name as it knows it — never the requester's name from the
  // card, which would always mismatch on a real two-node topology.
  const receiverPeer = input.receiverPeer;
  const requestId = input.identity.requestId;
  const contributionRef = input.identity.contributionRef;

  const projection = buildTerminalProjection(input, receiverPeer);
  const eventId = `${input.kind === "completed" ? "accept" : "fail"}_${requestId}_${contributionRef}_${input.decisionId.replace(/[^a-zA-Z0-9]/g, "_")}`.slice(0, 128);

  return {
    peer: input.identity.requesterPeer,
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
}

/** A terminal projection summary must never be empty (contract rejects zero-length). */
function effectiveSummary(summary: string): string {
  return summary.trim().length === 0 ? "Project blocked" : summary;
}

function buildTerminalProjection(input: BuildPeerTerminalEventInput, receiverPeer: string): ContributionProjectionV1 {
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
