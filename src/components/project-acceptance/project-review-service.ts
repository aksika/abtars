import { ProjectReviewStore } from "./project-review-store.js";
import type { ProjectMutationAuthority } from "./project-review-store.js";
import { ProjectReviewValidator, type ProjectReviewDecisionV1 } from "./project-review-validator.js";
import type { ValidationIssue } from "./project-review-contract.js";
import type { ReviewCaseSnapshot } from "./project-review-case.js";
import { nerve } from "../nerve.js";
import { randomUUID } from "node:crypto";
import { logAndSwallow } from "../log-and-swallow.js";

const TAG = "project-review";

const MAX_INVALID_PROPOSALS = 5;

/** #1620: stable blocker class for protocol exhaustion — review failed, criteria were not semantically evaluated. */
export const REVIEW_PROTOCOL_EXHAUSTED = "review_protocol_exhausted";

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
      // #1680: transport request resolution is NOT delivery success. Only the
      // requester's literal `{ ok: true }` application ACK authorizes `sent_at`.
      // A negative, malformed, or timed-out response keeps the row pending.
      const ack = await broker.sendRequest<unknown>(row.peer, "help.event.v1", JSON.parse(row.payload_json));
      const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
      if (!isRecord(ack) || ack.ok !== true) {
        throw new Error("help_event_not_applied");
      }
      if (store.markAcceptanceOutboxSent(row.id)) sent++;
    } catch (err) {
      store.markAcceptanceOutboxAttempt(row.id, err instanceof Error ? err.message : String(err));
    }
  }
  return sent;
}

export type ReviewOutcome =
  | { kind: "accepted"; decisionId: string; summary: string; warnings?: readonly string[] }
  | { kind: "repair"; decisionId: string; summary: string; warnings?: readonly string[] }
  | { kind: "blocked"; decisionId: string; summary: string; warnings?: readonly string[] }
  | { kind: "needs_input"; decisionId: string; summary: string; warnings?: readonly string[] }
  | {
      kind: "invalid";
      errors: readonly string[];
      issues: readonly ValidationIssue[];
      invalidProposalCount: number;
      remainingAttempts: number;
    }
  | { kind: "blocked_invalid"; decisionId: string; summary: string; invalidProposalCount: number };

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
   * #1620: validation issues are partitioned by severity — errors reject and
   * count against the invalid-proposal budget; warnings ride along on
   * successful outcomes and never increment the counter.
   */
  processDecision(decision: ProjectReviewDecisionV1, authority?: ProjectMutationAuthority): ReviewOutcome {
    // Load the case
    const caseRow = this.store.getReviewCase(decision.review_case_id);
    if (!caseRow) {
      return { kind: "invalid", errors: [`review case "${decision.review_case_id}" not found`], issues: [], invalidProposalCount: 0, remainingAttempts: MAX_INVALID_PROPOSALS };
    }

    if (caseRow.status !== "open") {
      return { kind: "invalid", errors: [`review case "${decision.review_case_id}" is ${caseRow.status}, not open`], issues: [], invalidProposalCount: 0, remainingAttempts: MAX_INVALID_PROPOSALS };
    }

    let caseSnapshot: ReviewCaseSnapshot;
    try {
      caseSnapshot = JSON.parse(caseRow.case_json) as ReviewCaseSnapshot;
    } catch {
      return { kind: "invalid", errors: ["failed to parse case snapshot"], issues: [], invalidProposalCount: 0, remainingAttempts: MAX_INVALID_PROPOSALS };
    }
    if (!caseSnapshot || caseSnapshot.schema_version !== 1 ||
        caseSnapshot.project_card_id !== caseRow.project_card_id ||
        caseSnapshot.generation !== caseRow.generation) {
      return { kind: "invalid", errors: ["review case snapshot is structurally invalid"], issues: [], invalidProposalCount: 0, remainingAttempts: MAX_INVALID_PROPOSALS };
    }

    // Validate the decision
    const issues = this.validator.validateDecision(decision, caseSnapshot);
    const errors = issues.filter(i => i.severity === "error");
    const warnings = issues.filter(i => i.severity === "warn");

    if (errors.length > 0) {
      // A foreign project/generation is a stale or misbound invocation, not a
      // proposal for this case. Fail closed without spending this case's
      // correction budget; the Orc tool performs the same check before calling
      // the service, but the service must remain safe for direct callers too.
      if (decision.project_card_id !== caseRow.project_card_id || decision.project_generation !== caseRow.generation) {
        return {
          kind: "invalid",
          errors: errors.map(e => `[${e.path}] ${e.message}`),
          issues: errors,
          invalidProposalCount: 0,
          remainingAttempts: MAX_INVALID_PROPOSALS,
        };
      }

      // Track and, at the threshold, settle in one SQLite transaction. A
      // concurrent duplicate therefore cannot increment after the winning
      // fifth proposal has already terminalized the case.
      const cardId = caseRow.project_card_id;
      const decisionId = `rd_block_${cardId}_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const summary = `Project blocked after ${MAX_INVALID_PROPOSALS} invalid proposals: review_protocol_exhausted; no valid semantic decision was produced`;
      const recipe = { kind: "failed" as const, summary, evidenceSource: caseSnapshot };
      const exhaustionDecision = {
        action: "blocked",
        blocker_class: REVIEW_PROTOCOL_EXHAUSTED,
        reason: "review protocol exhausted before a valid semantic decision",
      };
      const record = this.store.recordInvalidProposal(
        cardId,
        decision.review_case_id,
        MAX_INVALID_PROPOSALS,
        { ...exhaustionDecision, invalid_proposals: MAX_INVALID_PROPOSALS },
        REVIEW_PROTOCOL_EXHAUSTED,
        recipe,
        decisionId,
        authority,
      );
      if (record.kind === "blocked") {
        try { nerve.fire("card:failed", cardId); } catch (err) { logAndSwallow(TAG, "fire card:failed", err); }
        return {
          kind: "blocked_invalid",
          decisionId: record.decisionId,
          summary,
          invalidProposalCount: record.total,
        };
      }
      const count = record.total;
      return {
        kind: "invalid",
        errors: errors.map(e => `[${e.path}] ${e.message}`),
        issues: errors,
        invalidProposalCount: count,
        remainingAttempts: Math.max(0, MAX_INVALID_PROPOSALS - count),
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
        const recipe = { kind: "completed" as const, summary: deliveredSynthesis, evidenceSource: caseSnapshot };
        const { decisionId } = this.store.settleAcceptance(
          cardId,
          decision.review_case_id,
          decision,
          deliveredSynthesis,
          recipe,
          acceptanceId,
          authority,
        );

        // Fire events after commit
        try { nerve.fire("card:done", cardId); } catch (err) { logAndSwallow(TAG, "fire card:done", err); }
        return {
          kind: "accepted",
          decisionId,
          summary: `Project accepted: ${deliveredSynthesis.slice(0, 200)}`,
          warnings: warnings.map(w => `[${w.path}] ${w.message}`),
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
          authority,
        );

        return {
          kind: "repair",
          decisionId,
          summary: `Repair planned: ${repairItems.length} items (${repairItems.map(i => i.affected_criterion_ids.join(",")).join("; ")})`,
          warnings: warnings.map(w => `[${w.path}] ${w.message}`),
        };
      }

      case "blocked": {
        const blocker = decision.blocker!;
        // #1618: a blocked receiver settlement emits a FAILED terminal event —
        // never false success — in the same transaction as the settlement.
        const decisionId = `rd_block_${cardId}_${Date.now()}_${randomUUID().slice(0, 8)}`;
        const recipe = { kind: "failed" as const, summary: `Project blocked: ${blocker.blocker_class}`, evidenceSource: caseSnapshot };
        // Atomic settlement: decision + supervision + kanban in one transaction
        const { decisionId: settledId } = this.store.settleBlocked(
          cardId,
          decision.review_case_id,
          decision,
          blocker.blocker_class,
          recipe,
          decisionId,
          authority,
        );
        // Fire events after commit
        try { nerve.fire("card:failed", cardId); } catch (err) { logAndSwallow(TAG, "fire card:failed", err); }
        return {
          kind: "blocked",
          decisionId: settledId,
          summary: `Project blocked: ${blocker.blocker_class}`,
          warnings: warnings.map(w => `[${w.path}] ${w.message}`),
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
          authority,
        );
        // #1480: durable run release is owned by the bound Orc execution;
        // no process-global active-card state is cleared here.
        return {
          kind: "needs_input",
          decisionId,
          summary: `Input requested: ${inputReq.question.slice(0, 200)}`,
          warnings: warnings.map(w => `[${w.path}] ${w.message}`),
        };
      }

      default:
        return { kind: "invalid", errors: [`unknown action: ${decision.action}`], issues: [], invalidProposalCount: 0, remainingAttempts: MAX_INVALID_PROPOSALS };
    }
  }
}
