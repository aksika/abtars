import { ProjectReviewStore } from "./project-review-store.js";
import { ProjectReviewValidator, type ProjectReviewDecisionV1 } from "./project-review-validator.js";
import type { ReviewCaseSnapshot } from "./project-review-case.js";
import type { ContributionProjectionV1 } from "../peer-help/contract.js";
import { nerve } from "../nerve.js";
import { randomUUID } from "node:crypto";

const MAX_INVALID_PROPOSALS = 5;

function buildPeerAcceptanceEvent(cardId: number, acceptanceId: string, synthesis: string, caseSnapshot?: ReviewCaseSnapshot): { peer: string; payload: unknown } | undefined {
  try {
    const { kanbanGetCard } = require("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
    const card = kanbanGetCard(cardId);
    if (!card?.source_peer || !card.notes) return undefined;
    const notes = JSON.parse(card.notes) as Record<string, unknown>;
    const requestId = typeof notes.request_id === "string" ? notes.request_id : undefined;
    const contributionRef = typeof notes.contribution_ref === "string" ? notes.contribution_ref : undefined;
    if (!requestId || !contributionRef) return undefined;

    const projection: ContributionProjectionV1 | undefined = caseSnapshot && buildTerminalProjection(caseSnapshot, card.source_peer, acceptanceId, synthesis);
    const eventId = `accept_${requestId}_${contributionRef}_${acceptanceId.replace(/[^a-zA-Z0-9]/g, "_")}`.slice(0, 128);

    return {
      peer: card.source_peer,
      payload: {
        version: 1,
        event_id: eventId,
        sequence: 0,
        request_id: requestId,
        contribution_ref: contributionRef,
        kind: "completed",
        occurred_at: new Date().toISOString(),
        summary: synthesis.slice(0, 1000),
        projection,
      },
    };
  } catch {
    return undefined;
  }
}

function buildTerminalProjection(snapshot: ReviewCaseSnapshot, receiverPeer: string, acceptanceId: string, synthesis: string): ContributionProjectionV1 {
  const MAX_EVIDENCE_ITEMS = 20;
  const MAX_EVIDENCE_ID_LENGTH = 128;
  const evidence: Array<{ id: string; kind: string; summary: string; observed_by: string }> = [];
  for (const ci of snapshot.criterion_inputs) {
    for (const eid of ci.observed_evidence_ids.slice(0, MAX_EVIDENCE_ITEMS)) {
      evidence.push({ id: eid.slice(0, MAX_EVIDENCE_ID_LENGTH), kind: "check", summary: "observed", observed_by: receiverPeer.slice(0, 64) });
    }
    for (const eid of ci.artifact_observation_ids.slice(0, MAX_EVIDENCE_ITEMS)) {
      evidence.push({ id: eid.slice(0, MAX_EVIDENCE_ID_LENGTH), kind: "artifact", summary: "present", observed_by: receiverPeer.slice(0, 64) });
    }
  }
  return {
    schema_version: 1,
    outcome: "completed",
    summary: synthesis.slice(0, 1000),
    evidence: evidence.slice(0, MAX_EVIDENCE_ITEMS),
    artifacts: [],
    provenance: {
      receiver_peer: receiverPeer,
      receiver_project_ref: snapshot.root_contract?.id?.slice(0, 128) ?? `project_${snapshot.project_card_id}`,
      acceptance_id: acceptanceId,
      accepted_at: new Date().toISOString(),
    },
  };
}

export async function drainAcceptanceOutbox(): Promise<number> {
  const store = new ProjectReviewStore();
  const pending = store.getPendingAcceptanceOutbox();
  if (pending.length === 0) return 0;
  const { getPeerWsBroker } = await import("../peer-transport/peer-ws-broker.js");
  const broker = getPeerWsBroker();
  if (!broker) return 0;
  let sent = 0;
  for (const row of pending) {
    try {
      await broker.sendRequest(row.peer, "help.event.v1", JSON.parse(row.payload_json));
      if (store.markAcceptanceOutboxSent(row.id)) sent++;
    } catch (err) {
      store.markAcceptanceOutboxAttempt(row.id, err instanceof Error ? err.message : String(err));
    }
  }
  return sent;
}

export type ReviewOutcome =
  | { kind: "accepted"; decisionId: string; summary: string }
  | { kind: "repair"; decisionId: string; summary: string }
  | { kind: "blocked"; decisionId: string; summary: string }
  | { kind: "needs_input"; decisionId: string; summary: string }
  | { kind: "invalid"; errors: readonly string[] }
  | { kind: "blocked_invalid"; decisionId: string; summary: string };

/** #1605: cap for the rendered synthesis (card result summary limit is 4000). */
export const RENDERED_SYNTHESIS_MAX = 4000;
const RENDERED_RATIONALE_MAX = 500;

/**
 * #1605: pure renderer for the delivered synthesis. Returns the authored
 * synthesis unchanged when there are no accepted optional gaps; otherwise
 * appends a canonical, bounded "Known gaps" section in root-contract order so
 * the Orc's declared omissions reach the user deterministically.
 */
export function renderAcceptedSynthesis(
  decision: ProjectReviewDecisionV1,
  caseSnapshot: ReviewCaseSnapshot,
): string {
  const policyByCriterionId = new Map(caseSnapshot.criterion_inputs.map(ci => [ci.criterion_id, ci]));
  const gaps = decision.criteria
    .filter(c => {
      const policy = policyByCriterionId.get(c.criterion_id);
      if (!policy) return false;
      return !policy.required && (c.verdict === "unsatisfied" || c.verdict === "inconclusive");
    })
    .map(c => ({ id: c.criterion_id, verdict: c.verdict, rationale: c.rationale }));
  if (gaps.length === 0) return decision.synthesis;

  const order = new Map(caseSnapshot.root_contract.criteria.map((c, i) => [c.id, i]));
  const ordered = [...gaps].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const sectionPrefix = "\n\nKnown gaps:\n";
  const linePrefixes = ordered.map(g => `- ${g.id}: ${g.verdict} — `);
  const fixedSectionLength = sectionPrefix.length + linePrefixes.join("\n").length;

  // Reserve the bounded result for the complete gap list first. When many
  // optional gaps exist, ration the rationale budget across them rather than
  // truncating the finished section and silently dropping later gap IDs.
  let rationaleBudget = Math.max(0, RENDERED_SYNTHESIS_MAX - fixedSectionLength);
  const lines = ordered.map((g, index) => {
    const remainingGaps = ordered.length - index;
    const allowance = Math.min(RENDERED_RATIONALE_MAX, Math.floor(rationaleBudget / remainingGaps));
    const rationale = g.rationale.slice(0, allowance);
    rationaleBudget -= rationale.length;
    return linePrefixes[index] + rationale;
  });
  const section = sectionPrefix + lines.join("\n");

  // #1605: reserve space for the disclosure so a long authored synthesis can
  // never silently drop the Known gaps section or any normally-sized gap ID.
  // Extremely long criterion IDs can exceed the payload cap by themselves;
  // retain the hard result bound even for that malformed-but-stored case.
  const boundedSection = section.slice(0, RENDERED_SYNTHESIS_MAX);
  const maxBase = Math.max(0, RENDERED_SYNTHESIS_MAX - boundedSection.length);
  return decision.synthesis.slice(0, maxBase) + boundedSection;
}

export class ProjectReviewService {
  private store: ProjectReviewStore;
  private validator: ProjectReviewValidator;

  constructor() {
    this.store = new ProjectReviewStore();
    this.validator = new ProjectReviewValidator();
  }

  /**
   * Process a review decision submitted by Orc.
   * Validates, persists, and transitions project state.
   */
  processDecision(decision: ProjectReviewDecisionV1): ReviewOutcome {
    // Load the case
    const caseRow = this.store.getReviewCase(decision.review_case_id);
    if (!caseRow) {
      return { kind: "invalid", errors: [`review case "${decision.review_case_id}" not found`] };
    }

    if (caseRow.status !== "open") {
      return { kind: "invalid", errors: [`review case "${decision.review_case_id}" is ${caseRow.status}, not open`] };
    }

    const caseSnapshot = JSON.parse(caseRow.case_json) as ReviewCaseSnapshot;
    if (!caseSnapshot) {
      return { kind: "invalid", errors: ["failed to parse case snapshot"] };
    }

    // Validate the decision
    const errors = this.validator.validateDecision(decision, caseSnapshot);
    if (errors.length > 0) {
      // Track invalid proposals
      const { total, requestId } = this.store.incrementInvalidProposals(decision.review_case_id);
      if (total >= MAX_INVALID_PROPOSALS && requestId) {
        const cardId = decision.project_card_id;
        const { decisionId } = this.store.settleBlocked(cardId, decision.review_case_id, { action: "blocked", reason: "Exceeded max invalid proposals" }, `Exceeded ${MAX_INVALID_PROPOSALS} invalid proposals`);
        this.store.markReviewRequestSettled(requestId);
        try { nerve.fire("card:failed", cardId); } catch {}
        return {
          kind: "blocked_invalid",
          decisionId,
          summary: `Project blocked after ${total} invalid proposals`,
        };
      }
      return {
        kind: "invalid",
        errors: errors.map(e => `[${e.path}] ${e.message}`),
      };
    }

    const cardId = decision.project_card_id;

    switch (decision.action) {
      case "accept": {
        // #1605: the delivered synthesis carries the Orc's declared optional
        // omissions deterministically; the authored decision JSON stays as the
        // Orc wrote it.
        const deliveredSynthesis = renderAcceptedSynthesis(decision, caseSnapshot);
        // Atomic settlement: decision + supervision + kanban in one transaction
        const acceptanceId = `rd_settle_${cardId}_${Date.now()}_${randomUUID().slice(0, 8)}`;
        const peerEvent = buildPeerAcceptanceEvent(cardId, acceptanceId, deliveredSynthesis, caseSnapshot);
        const { decisionId } = this.store.settleAcceptance(
          cardId,
          decision.review_case_id,
          decision,
          deliveredSynthesis,
          peerEvent,
          acceptanceId,
        );

        // Fire events after commit
        try { nerve.fire("card:done", cardId); } catch {}
        return {
          kind: "accepted",
          decisionId,
          summary: `Project accepted: ${deliveredSynthesis.slice(0, 200)}`,
        };
      }

      case "repair": {
        const repairItems = decision.repair?.items ?? [];
        // Persist the decision, advance generation, close the review turn, and
        // reserve repair budget together so a restart cannot leave an open
        // case blocking the next review round.
        const totalRepairTokens = repairItems.reduce((sum, i) => sum + (i.budget?.max_tokens ?? 0), 0);
        const { decisionId } = this.store.settleRepair(
          cardId,
          decision.review_case_id,
          decision,
          caseSnapshot.generation,
          totalRepairTokens,
        );

        return {
          kind: "repair",
          decisionId,
          summary: `Repair planned: ${repairItems.length} items (${repairItems.map(i => i.affected_criterion_ids.join(",")).join("; ")})`,
        };
      }

      case "blocked": {
        const blocker = decision.blocker!;
        // Atomic settlement: decision + supervision + kanban in one transaction
        const { decisionId } = this.store.settleBlocked(
          cardId,
          decision.review_case_id,
          decision,
          blocker.blocker_class,
        );
        // Fire events after commit
        try { nerve.fire("card:failed", cardId); } catch {}
        return {
          kind: "blocked",
          decisionId,
          summary: `Project blocked: ${blocker.blocker_class}`,
        };
      }

      case "needs_input": {
        const inputReq = decision.input_request!;
        const { decisionId } = this.store.settleNeedsInput(
          cardId,
          decision.review_case_id,
          decision,
          {
            question: inputReq.question,
            affectedCriterionIds: inputReq.affected_criterion_ids,
            expectedResponseKind: inputReq.expected_response_kind,
            context: inputReq.context,
          },
        );
        // #1480: durable run release is owned by the bound Orc execution;
        // no process-global active-card state is cleared here.
        return {
          kind: "needs_input",
          decisionId,
          summary: `Input requested: ${inputReq.question.slice(0, 200)}`,
        };
      }

      default:
        return { kind: "invalid", errors: [`unknown action: ${decision.action}`] };
    }
  }
}
