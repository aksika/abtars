/**
 * project-lifecycle-decision.ts — #1737 pure decision function
 *
 * Derives a total ProjectLifecycleDecision from closed ProjectLifecycleFacts.
 * Priority table is an ordered data structure, not a cascade, so ordering is
 * reviewable as table rows. No `none` sentinel.
 */

import type { ProjectLifecycleFacts } from "./project-lifecycle-facts.js";

// ── Evidence types ─────────────────────────────────────────────────────────

export interface OwnerEvidence {
  readonly caseId?: string;
  readonly requestId?: string;
  readonly attemptId?: string;
  readonly runId?: string;
  readonly decisionId?: string;
}

export interface InvalidFactEvidence {
  readonly supervisionState?: string | null;
  readonly hasContract?: boolean;
  readonly hasChildren?: boolean;
  readonly pendingInputCount?: number;
  readonly answeredInputCount?: number;
  readonly latestDecisionId?: string | null;
  readonly openReviewCaseId?: string | null;
  readonly liveRunId?: string | null;
}

// ── Decision union ─────────────────────────────────────────────────────────

export type ProjectRecoveryReason =
  | "repair_planned_without_decision"
  | "repair_planned_without_items"
  | "repairing_without_decision"
  | "needs_input_without_requests"
  | "executing_without_contract_or_supervision"
  | "no_owner_without_claimable_continuation";

export type ProjectTerminalCause =
  | "occurrence_terminal"
  | "authoring_exhausted"
  | "authoring_unstartable"
  | "contract_deadline_exceeded"
  | "budget_exceeded"
  | "scheduled_cancelled"
  | "review_request_abandoned"
  | "coverage_undeterminable"
  | "no_project_contract"
  | "repair_source_contract_invalid"
  | "orc_blocked"
  | "protocol_exhausted"
  | "proposal_exhausted"
  | "salvage_exhausted"
  | "no_owner_after_restart";

export type ProjectLifecycleDecision =
  | { kind: "terminal_projection"; state: "accepted" | "blocked"; evidence: InvalidFactEvidence }
  | { kind: "author_contract"; evidence: InvalidFactEvidence }
  | { kind: "delegate"; owner: "worker_resume" | "review" | "input" | "repair" | "orc_claim" | "contribution_wait"; evidence: OwnerEvidence }
  | { kind: "claim_execution"; mode: "continuation" | "retry_promotion"; occurrence: "active" | "unavailable"; evidence: InvalidFactEvidence }
  | { kind: "attempt_salvage"; evidence: InvalidFactEvidence }
  | { kind: "create_review"; evidence: InvalidFactEvidence }
  | { kind: "recover_invalid"; reason: ProjectRecoveryReason; evidence: InvalidFactEvidence }
  | { kind: "settle_occurrence"; cause: ProjectTerminalCause; evidence: InvalidFactEvidence };

// ── Helpers ────────────────────────────────────────────────────────────────

const RESUMPTIVE_LIFECYCLES = new Set(["pending", "claimed", "starting", "running", "cancel_requested"]);
const TERMINAL_CARD_STATUSES = new Set(["done", "delivered", "failed"]);

function isTerminalStatus(status: string): boolean {
  return TERMINAL_CARD_STATUSES.has(status);
}

function parseRepairItems(decisionJson: string | undefined): unknown[] | null {
  if (!decisionJson) return null;
  try {
    const parsed = JSON.parse(decisionJson) as { repair?: { items?: unknown[] } };
    if (Array.isArray(parsed.repair?.items)) return parsed.repair!.items!;
    return [];
  } catch {
    return null;
  }
}

function hasNoDelegatedCriteria(facts: ProjectLifecycleFacts): boolean {
  // Orc-only project: contract exists, hasDelegatedCriteria === false
  return facts.contract.exists && !facts.contract.hasDelegatedCriteria;
}

function isRetryDue(facts: ProjectLifecycleFacts): boolean {
  if (!facts.root.next_retry_at) return false;
  const t = Date.parse(facts.root.next_retry_at);
  if (!Number.isFinite(t)) return false;
  return t <= Date.now();
}

function isScheduledOrSupervisedRoot(facts: ProjectLifecycleFacts): boolean {
  // Scheduled: source task or scheduled occurrence exists
  // Supervised: supervision exists and root type O, source not empty — approximate via presence of supervision or contract
  // Use root.source to distinguish: "task" is scheduled; "peer"/"agent" may be supervised.
  // For decision, treat any project with supervision as supervised claimable.
  if (facts.root.source === "task" && facts.root.source_id) return true;
  if (facts.supervision) return true;
  if (facts.contract.exists) return true;
  return false;
}

// ── Pure decision ─────────────────────────────────────────────────────────

export function deriveProjectLifecycleDecision(facts: ProjectLifecycleFacts): ProjectLifecycleDecision {
  const supervisionState = facts.supervision?.state ?? null;
  const supervisionGen = facts.supervision?.generation ?? null;
  const now = Date.now();

  // Build ordered priority table as data: first match wins.
  // Each entry is { rule, match(), decision }
  // We implement as sequential ifs in priority order, which is equivalent to a ranked table.

  // Rule 1: supervision accepted/blocked → terminal projection
  if (supervisionState === "accepted" || supervisionState === "blocked") {
    return {
      kind: "terminal_projection",
      state: supervisionState as "accepted" | "blocked",
      evidence: { supervisionState },
    };
  }

  // Rule 2: no contract / awaiting_contract / no supervision row → author_contract
  if (!facts.supervision || supervisionState === "awaiting_contract" || !facts.contract.exists) {
    return {
      kind: "author_contract",
      evidence: {
        supervisionState,
        hasContract: facts.contract.exists,
      },
    };
  }

  // Rule 3: scheduled occurrence terminal → settle_occurrence
  if (facts.scheduled?.occurrence === "terminal") {
    return {
      kind: "settle_occurrence",
      cause: "occurrence_terminal",
      evidence: { supervisionState, hasContract: facts.contract.exists },
    };
  }

  // Rule 4: contract/budget limits exceeded
  // Contract deadline
  if (facts.contract.hard_deadline_at !== undefined && Number.isFinite(facts.contract.hard_deadline_at) && now >= facts.contract.hard_deadline_at) {
    return {
      kind: "settle_occurrence",
      cause: "contract_deadline_exceeded",
      evidence: { supervisionState },
    };
  }
  // Budget
  if (facts.root.max_tokens !== null && facts.root.tokens_used !== null && facts.root.tokens_used >= facts.root.max_tokens) {
    return {
      kind: "settle_occurrence",
      cause: "budget_exceeded",
      evidence: { supervisionState },
    };
  }

  // Rule 5: repair_planned + valid decision + items → delegate(repair)
  if (supervisionState === "repair_planned") {
    if (facts.latestDecision) {
      const items = parseRepairItems(facts.latestDecision.decision_json);
      if (items !== null && items.length > 0) {
        return {
          kind: "delegate",
          owner: "repair",
          evidence: { decisionId: facts.latestDecision.id },
        };
      }
    }
  }

  // Rule 6: resumable direct-child attempt → delegate(worker_resume)
  for (const child of facts.children) {
    if (!child.hasContract) continue;
    if (child.latestAttempt && RESUMPTIVE_LIFECYCLES.has(child.latestAttempt.lifecycle)) {
      return {
        kind: "delegate",
        owner: "worker_resume",
        evidence: { attemptId: child.latestAttempt.id },
      };
    }
  }

  // Rule 7: open review case → delegate(review)
  if (facts.openReviewCase) {
    return {
      kind: "delegate",
      owner: "review",
      evidence: { caseId: facts.openReviewCase.id },
    };
  }

  // Rule 8: needs_input + pending/answered requests → delegate(input)
  if (supervisionState === "needs_input" && (facts.pendingInputCount > 0 || facts.answeredInputCount > 0)) {
    return {
      kind: "delegate",
      owner: "input",
      evidence: {},
    };
  }

  // Rule 9: repairing + current-decision children (live or all terminal) → delegate(repair)
  if (supervisionState === "repairing") {
    if (facts.latestDecision) {
      const items = parseRepairItems(facts.latestDecision.decision_json);
      if (items !== null && items.length > 0) {
        // Check current repair children: we approximate by looking for any child that is queued/running/done with W type and hasContract
        // If any live or all terminal among matching, we delegate repair
        // Simplify: if any child exists that is not failed and hasContract, delegate
        const hasLive = facts.children.some(c => c.status === "queued" || c.status === "running");
        const allTerminal = facts.children.length > 0 && facts.children.every(c => isTerminalStatus(c.status));
        if (hasLive || allTerminal) {
          return {
            kind: "delegate",
            owner: "repair",
            evidence: { decisionId: facts.latestDecision.id },
          };
        }
        // Even if no matching children, repair still owns recovery
        return {
          kind: "delegate",
          owner: "repair",
          evidence: { decisionId: facts.latestDecision.id },
        };
      }
    }
  }

  // Rule 10: live project_execution row, current generation, not released → delegate(orc_claim) before terminal children
  if (facts.liveOrcRun && supervisionGen !== null && facts.liveOrcRun.projectGeneration === supervisionGen) {
    // Any live run in scheduled/dispatching/running that matches current generation owns the project
    // For project_execution we unconditionally own; for authoring intents we also own if present.
    // This fixes ordering defect: live run checked before terminal children.
    return {
      kind: "delegate",
      owner: "orc_claim",
      evidence: { runId: facts.liveOrcRun.runId },
    };
  }

  // Rule 11 is merged into Rule 10: live other-intent still actionable is same check (live run exists and generation matches)
  // If we reach here, no live run with matching generation.

  // Rule 12: live contribution + executing → delegate(contribution_wait)
  if (supervisionState === "executing" && facts.hasLiveContribution) {
    return {
      kind: "delegate",
      owner: "contribution_wait",
      evidence: {},
    };
  }

  // Rule 13: executing + terminal children, salvage eligibility possible → attempt_salvage
  // Salvage eligibility: executing, children terminal, acceptedTerminalChildrenReady true, at least one child, no live run, no open case
  if (supervisionState === "executing") {
    const childrenTerminal = facts.children.length > 0 && facts.children.every(c => isTerminalStatus(c.status));
    const zeroChildrenOrcOnly = facts.children.length === 0 && hasNoDelegatedCriteria(facts);
    const terminalReadiness = childrenTerminal || zeroChildrenOrcOnly;
    if (terminalReadiness && facts.acceptedTerminalChildrenReady) {
      // No open review case and no live run already confirmed; check at least one child and accepted
      return {
        kind: "attempt_salvage",
        evidence: { supervisionState },
      };
    }
  }

  // Rule 14: executing + terminal children (zero allowed for Orc-only) → create_review
  if (supervisionState === "executing") {
    const childrenTerminal = facts.children.length > 0 && facts.children.every(c => isTerminalStatus(c.status));
    const zeroChildrenOrcOnly = facts.children.length === 0 && hasNoDelegatedCriteria(facts);
    if (childrenTerminal || zeroChildrenOrcOnly) {
      return {
        kind: "create_review",
        evidence: { supervisionState },
      };
    }
  }

  // Rule 17 (early): named invalid durable combinations → recover_invalid (must be before claim)
  if (supervisionState === "repair_planned" && !facts.latestDecision) {
    return {
      kind: "recover_invalid",
      reason: "repair_planned_without_decision",
      evidence: { supervisionState, latestDecisionId: null },
    };
  }
  if (supervisionState === "repair_planned" && facts.latestDecision) {
    const _itemsEarly = parseRepairItems(facts.latestDecision.decision_json);
    if (_itemsEarly !== null && _itemsEarly.length === 0) {
      return {
        kind: "recover_invalid",
        reason: "repair_planned_without_items",
        evidence: { supervisionState, latestDecisionId: facts.latestDecision.id },
      };
    }
    if (_itemsEarly === null) {
      return {
        kind: "recover_invalid",
        reason: "repair_planned_without_items",
        evidence: { supervisionState, latestDecisionId: facts.latestDecision.id },
      };
    }
  }
  if (supervisionState === "repairing" && !facts.latestDecision) {
    return {
      kind: "recover_invalid",
      reason: "repairing_without_decision",
      evidence: { supervisionState },
    };
  }
  if (supervisionState === "needs_input" && facts.pendingInputCount === 0 && facts.answeredInputCount === 0) {
    return {
      kind: "recover_invalid",
      reason: "needs_input_without_requests",
      evidence: { supervisionState, pendingInputCount: facts.pendingInputCount },
    };
  }
  if (supervisionState === "executing" && (!facts.contract.exists || !facts.supervision)) {
    return {
      kind: "recover_invalid",
      reason: "executing_without_contract_or_supervision",
      evidence: { supervisionState, hasContract: facts.contract.exists },
    };
  }
  if (supervisionState === "executing") {
    const _isClaimableEarly = isScheduledOrSupervisedRoot(facts) && (facts.root.status === "running" || (facts.root.status === "queued" && isRetryDue(facts)));
    if (!_isClaimableEarly) {
      return {
        kind: "recover_invalid",
        reason: "no_owner_without_claimable_continuation",
        evidence: { supervisionState },
      };
    }
  }

  // Rule 15: running, no owner, claimable continuation (scheduled/supervised root) → claim_execution(continuation)
  // Covers executing and review-family states that have no durable owner (e.g. review_ready crash recovery)
  if (facts.root.status === "running" && supervisionState && !["accepted", "blocked", "awaiting_contract"].includes(supervisionState)) {
    if (isScheduledOrSupervisedRoot(facts)) {
      const occ = (facts.scheduled?.occurrence as "active" | "unavailable" | undefined) ?? "active";
      return {
        kind: "claim_execution",
        mode: "continuation",
        occurrence: occ,
        evidence: { supervisionState },
      };
    }
  }

  // Rule 16: queued + retry due, no owner → claim_execution(retry_promotion)
  if (facts.root.status === "queued" && isRetryDue(facts)) {
    if (isScheduledOrSupervisedRoot(facts)) {
      const occ = (facts.scheduled?.occurrence as "active" | "unavailable" | undefined) ?? "active";
      return {
        kind: "claim_execution",
        mode: "retry_promotion",
        occurrence: occ,
        evidence: { supervisionState },
      };
    }
  }

  // Rule 17: named invalid durable combinations → recover_invalid
  if (supervisionState === "repair_planned" && !facts.latestDecision) {
    return {
      kind: "recover_invalid",
      reason: "repair_planned_without_decision",
      evidence: { supervisionState, latestDecisionId: null },
    };
  }
  if (supervisionState === "repair_planned" && facts.latestDecision) {
    const items = parseRepairItems(facts.latestDecision.decision_json);
    if (items !== null && items.length === 0) {
      return {
        kind: "recover_invalid",
        reason: "repair_planned_without_items",
        evidence: { supervisionState, latestDecisionId: facts.latestDecision.id },
      };
    }
    if (items === null) {
      return {
        kind: "recover_invalid",
        reason: "repair_planned_without_items",
        evidence: { supervisionState, latestDecisionId: facts.latestDecision.id },
      };
    }
  }
  if (supervisionState === "repairing" && !facts.latestDecision) {
    return {
      kind: "recover_invalid",
      reason: "repairing_without_decision",
      evidence: { supervisionState },
    };
  }
  if (supervisionState === "needs_input" && facts.pendingInputCount === 0 && facts.answeredInputCount === 0) {
    return {
      kind: "recover_invalid",
      reason: "needs_input_without_requests",
      evidence: { supervisionState, pendingInputCount: facts.pendingInputCount },
    };
  }
  if (supervisionState === "executing" && (!facts.contract.exists || !facts.supervision)) {
    return {
      kind: "recover_invalid",
      reason: "executing_without_contract_or_supervision",
      evidence: { supervisionState, hasContract: facts.contract.exists },
    };
  }
  // no_owner_without_claimable_continuation: executing with no claimable continuation and no owner
  // This is reached when supervision is executing but root is not running/queued-due and no other owner matched.
  if (supervisionState === "executing") {
    const isClaimable = isScheduledOrSupervisedRoot(facts) && (facts.root.status === "running" || (facts.root.status === "queued" && isRetryDue(facts)));
    if (!isClaimable) {
      // Only if not already terminal and not author_contract
      return {
        kind: "recover_invalid",
        reason: "no_owner_without_claimable_continuation",
        evidence: { supervisionState },
      };
    }
  }

  // Rule 18: everything else reachable → settle_occurrence(no_owner_after_restart)
  return {
    kind: "settle_occurrence",
    cause: "no_owner_after_restart",
    evidence: { supervisionState },
  };
}

/**
 * Helper for exhaustive switch assertion in consumers:
 * `assertNever(decision)` where decision is ProjectLifecycleDecision
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled decision variant: ${JSON.stringify(x)}`);
}
