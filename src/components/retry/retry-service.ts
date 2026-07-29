import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import { WorkerSupervisionService } from "../worker-supervision-service.js";
import { ExecutorLeaseStore } from "../executor-lease-store.js";
import { RetryStore, type DecisionStatus } from "./retry-store.js";
import { classify } from "./failure-classifier.js";
import type { FailureClassificationV1, ClassifyInput } from "./failure-classifier.js";
import { evaluatePolicy, computeBudget } from "./retry-policy.js";
import type { RetryPolicyDecision, RetryDisposition, RetryBudgetSnapshot } from "./retry-policy.js";
import { selectExecutor } from "./executor-selector.js";
import type { SelectionConstraints } from "./executor-selector.js";
import { buildDirective, deriveContractRevision, validateDirective, validateContractRevision } from "./retry-directive.js";
import type { RetryDirectiveV1, RetryMode } from "./retry-directive.js";
import { LocalExecutorCatalog } from "./local-executor-catalog.js";
import type { WorkerAcceptanceContractV1, WorkerResultEnvelopeV1 } from "../worker-contract.js";
import type { AttemptRow } from "../worker-supervision-store.js";

const GLOBAL_MAX_TOKENS = 1_000_000;

export interface RetryServiceDeps {
  db?: import("../tasks/kanban-board.js").TaskDatabase;
  supervisionStore?: WorkerSupervisionStore;
  supervisionService?: WorkerSupervisionService;
  leaseStore?: ExecutorLeaseStore;
  retryStore?: RetryStore;
  executorCatalog?: LocalExecutorCatalog;
  clock?: { now(): string };
}

export interface RetryReviewPacket {
  classification: FailureClassificationV1;
  decision: RetryPolicyDecision;
  directive?: RetryDirectiveV1;
  contract: WorkerAcceptanceContractV1;
  latestAttempt: AttemptRow;
  envelope?: WorkerResultEnvelopeV1;
  candidateSummary: string;
}

export interface OrcRetryResponse {
  action: "retry" | "stop" | "needs_input";
  strategy?: string;
  doNotRepeat?: string[];
  addedInputs?: Array<{ id: string; ref: string }>;
  addedChecks?: string[];
  preferredExecutorId?: string;
  rationale?: string;
}

export type AcceptRetryResult =
  | { kind: "created"; targetAttemptId: string }
  | { kind: "idempotent"; targetAttemptId: string }
  | { kind: "conflict" }
  | { kind: "stale_source" }
  | { kind: "budget_exhausted" }
  | { kind: "ineligible_executor" }
  | { kind: "error"; message: string }; // keep for backward compat

export class RetryService {
  private supStore: WorkerSupervisionStore;
  private supService: WorkerSupervisionService;
  private leaseStore: ExecutorLeaseStore;
  private retryStore: RetryStore;
  private executorCatalog: LocalExecutorCatalog;
  private clock: { now(): string };

  constructor(deps?: RetryServiceDeps) {
    this.supStore = deps?.supervisionStore ?? new WorkerSupervisionStore(deps?.db);
    this.supService = deps?.supervisionService ?? new WorkerSupervisionService(deps?.db);
    this.leaseStore = deps?.leaseStore ?? new ExecutorLeaseStore();
    this.retryStore = deps?.retryStore ?? new RetryStore(deps?.db);
    this.executorCatalog = deps?.executorCatalog ?? new LocalExecutorCatalog();
    this.clock = deps?.clock ?? { now: () => new Date().toISOString() };
  }

  reduceTerminalAttempt(attemptId: string, cardId: number): { classification: FailureClassificationV1; decision: RetryPolicyDecision } | { error: string } {
    const attempt = this.supStore.getAttempt(attemptId);
    if (!attempt) return { error: `attempt ${attemptId} not found` };
    if (!this.supStore.isAttemptTerminal(attempt.lifecycle)) {
      return { error: `attempt ${attemptId} is not terminal (${attempt.lifecycle})` };
    }

    const contract = this.supService.getContractForCard(cardId);
    if (!contract) return { error: `no contract for card ${cardId}` };

    const resultRow = this.supStore.getResultByAttempt(attemptId);

    // Typed classify input — no as any
    const classifyInput: ClassifyInput = {
      attempt_id: attemptId,
      envelope: resultRow?.envelope,
      leaseSnapshot: this.leaseStore.getSnapshot(attemptId),
      lifecycle: attempt.lifecycle,
      lifecycleReason: attempt.cancel_reason ?? undefined,
      cancelReason: attempt.cancel_reason ?? undefined,
      hasPendingInput: false,
    };
    const { classification } = classify(classifyInput);

    const insertResult = this.retryStore.insertClassification(classification);
    if (insertResult === "idempotent") {
      const existing = this.retryStore.getClassification(attemptId);
      const existingDecision = this.retryStore.getDecision(attemptId);
      if (existing && existingDecision) {
        return { classification: existing, decision: existingDecision.decision };
      }
    }
    if (insertResult === "conflict") {
      return { error: `classification conflict for ${attemptId}` };
    }

    // Store-backed budget with same-class count from stored classifications
    const budget = this.retryStore.getFullLineageBudget(cardId, classification.primary);

    const previousExecutors = this.getPreviousExecutors(cardId);

    const budgetSnapshot: RetryBudgetSnapshot = computeBudget(
      budget.totalAttempts,
      budget.sameClassCount,
      budget.consecutiveSameExecutorFails,
      budget.executorSwitches,
      budget.elapsedMs,
      budget.totalTokens,
      budget.totalCost,
      attempt.hard_deadline_at ?? undefined,
    );

    // Get eligible executors from catalog
    const constraints: SelectionConstraints = {
      requiredCapabilities: [...(contract.required_capabilities ?? [])],
    };
    const candidates = this.executorCatalog.getCandidates(constraints);
    const candidateIds = candidates.eligible.map(c => c.id);

    // Policy decision
    const decision = evaluatePolicy({
      sourceAttemptId: attemptId,
      classification: { primary: classification.primary, retryability: classification.retryability, factors: classification.factors },
      budgets: budgetSnapshot,
      candidateExecutorIds: candidateIds,
      previousExecutors,
    });

    this.retryStore.insertDecision(decision, mapDispositionToStatus(decision.disposition));

    return { classification, decision };
  }

  acceptAutomaticRetry(sourceAttemptId: string, cardId: number): AcceptRetryResult {
    const classification = this.retryStore.getClassification(sourceAttemptId);
    if (!classification) return { kind: "error", message: `no classification for ${sourceAttemptId}` };

    const decisionResult = this.retryStore.getDecision(sourceAttemptId);
    if (!decisionResult) return { kind: "error", message: `no decision for ${sourceAttemptId}` };
    if (decisionResult.status !== "scheduled") {
      return { kind: "error", message: `decision ${sourceAttemptId} not scheduled (${decisionResult.status})` };
    }

    const contract = this.supService.getContractForCard(cardId);
    if (!contract) return { kind: "error", message: `no contract for card ${cardId}` };

    const attempt = this.supStore.getAttempt(sourceAttemptId);
    if (!attempt) return { kind: "error", message: `attempt ${sourceAttemptId} not found` };

    const candidates = this.executorCatalog.getCandidates({
      requiredCapabilities: [...contract.required_capabilities],
    });
    if (candidates.eligible.length === 0) return { kind: "ineligible_executor" };

    const { selected, rationale } = selectExecutor(
      candidates.eligible,
      { requiredCapabilities: [...contract.required_capabilities] },
      [attempt.executor_id],
    );
    if (!selected) return { kind: "ineligible_executor" };

    const targetOrdinal = this.supStore.nextOrdinal(cardId);
    const isTransient = classification.primary === "transient_transport" || classification.primary === "executor_unavailable";
    const mode: RetryMode = isTransient ? "clean_rerun" : "strategy_change";
    const instruction = isTransient
      ? `Clean rerun of original goal. Previous attempt ${sourceAttemptId} failed with transient ${classification.primary}.`
      : `Retry with changed approach. Previous attempt ${sourceAttemptId} failed with ${classification.primary}. ${decisionResult.decision.reasonCode}`;

    const directive = buildDirective(
      contract, sourceAttemptId, targetOrdinal, classification, decisionResult.decision, rationale,
      {
        mode,
        instruction,
        doNotRepeat: isTransient ? [] : ["repeat same approach"],
        authoredBy: "policy",
        failedCriterionIds: [],
        unresolvedRisks: [],
        boundedSummary: classification.recommended_actions.join("; "),
      },
    );

    const nextRevision = this.supStore.getNextRevision(cardId);
    const revisedContract = deriveContractRevision(contract, directive, cardId, nextRevision);

    const errors = validateDirective(directive as unknown as Record<string, unknown>);
    if (errors.length > 0) return { kind: "error", message: `directive invalid: ${errors.join("; ")}` };

    const revErrors = validateContractRevision(contract, revisedContract);
    if (revErrors.length > 0) return { kind: "error", message: `contract revision invalid: ${revErrors.join("; ")}` };

    const targetAttemptId = this.generateAttemptId();
    const earliestClaimAt = decisionResult.decision.earliestAt ?? this.clock.now();

    const budget = this.retryStore.getFullLineageBudget(cardId);
    const budgetReservation = {
      tokens: Math.min(GLOBAL_MAX_TOKENS - budget.totalTokens, budget.totalTokens > 0 ? budget.totalTokens : 5000),
      cost: 0,
      switches: attempt.executor_id !== selected.id ? 1 : 0,
    };

    const outcome = this.retryStore.acceptDirectiveAndAllocateTarget(
      sourceAttemptId, cardId, classification, decisionResult.decision, directive,
      revisedContract, targetAttemptId, selected.kind, selected.id,
      earliestClaimAt, budgetReservation,
      {
        id: targetAttemptId,
        card_id: cardId,
        contract_id: revisedContract.id,
        ordinal: targetOrdinal,
        executor_kind: selected.kind,
        executor_id: selected.id,
        status: "pending",
        started_at: this.clock.now(),
        source_attempt_id: sourceAttemptId,
        earliest_claim_at: earliestClaimAt,
      },
    );

    if (outcome.kind === "created") return { kind: "created" as const, targetAttemptId };
    if (outcome.kind === "idempotent") return { kind: "idempotent" as const, targetAttemptId };
    return outcome as AcceptRetryResult;
  }

  reviewFailure(input: { attemptId: string; cardId: number; response: OrcRetryResponse }): AcceptRetryResult {
    const { attemptId, cardId, response } = input;

    const existingDecision = this.retryStore.getDecision(attemptId);
    if (!existingDecision) return { kind: "error", message: `no decision for ${attemptId}` };
    if (existingDecision.status === "consumed" || existingDecision.status === "stopped") {
      return { kind: "error", message: `decision already ${existingDecision.status}` };
    }

    if (response.action === "stop") {
      this.retryStore.compareAndSetDecisionStatus(attemptId, existingDecision.status as DecisionStatus, "stopped");
      return { kind: "error", message: "Orc chose stop" };
    }

    if (response.action === "needs_input") {
      this.retryStore.compareAndSetDecisionStatus(attemptId, existingDecision.status as DecisionStatus, "needs_input");
      return { kind: "error", message: "needs fresh input" };
    }

    // Action is "retry" — build directive and allocate
    const classification = this.retryStore.getClassification(attemptId);
    if (!classification) return { kind: "error", message: `no classification for ${attemptId}` };

    const contract = this.supService.getContractForCard(cardId);
    if (!contract) return { kind: "error", message: "no contract" };

    const attempt = this.supStore.getAttempt(attemptId);
    if (!attempt) return { kind: "error", message: "attempt not found" };

    const candidates = this.executorCatalog.getCandidates({
      requiredCapabilities: [...contract.required_capabilities],
      preferredId: response.preferredExecutorId,
    });
    if (candidates.eligible.length === 0) return { kind: "ineligible_executor" };

    const { selected, rationale } = selectExecutor(
      candidates.eligible,
      { requiredCapabilities: [...contract.required_capabilities], preferredId: response.preferredExecutorId },
      [attempt.executor_id],
    );
    if (!selected) return { kind: "ineligible_executor" };

    const targetOrdinal = this.supStore.nextOrdinal(cardId);
    const mode: RetryMode = response.strategy?.includes("executor") ? "executor_escalation" : "repair";

    const directive = buildDirective(
      contract, attemptId, targetOrdinal, classification, existingDecision.decision, rationale,
      {
        mode,
        instruction: response.strategy ?? `Repair: ${classification.primary}`,
        doNotRepeat: response.doNotRepeat,
        addedInputs: response.addedInputs,
        addedChecks: response.addedChecks,
        authoredBy: "orc",
      },
    );

    const errors = validateDirective(directive as unknown as Record<string, unknown>);
    if (errors.length > 0) return { kind: "error", message: `directive invalid: ${errors.join("; ")}` };

    const nextRevision = this.supStore.getNextRevision(cardId);
    const revisedContract = deriveContractRevision(contract, directive, cardId, nextRevision);
    const revErrors = validateContractRevision(contract, revisedContract);
    if (revErrors.length > 0) return { kind: "error", message: `contract revision invalid: ${revErrors.join("; ")}` };

    const targetAttemptId = this.generateAttemptId();
    const earliestClaimAt = existingDecision.decision.earliestAt ?? this.clock.now();
    const startedAt = this.clock.now();

    const budget = this.retryStore.getFullLineageBudget(cardId);
    const budgetReservation = {
      tokens: Math.min(GLOBAL_MAX_TOKENS - budget.totalTokens, 5000),
      cost: 0,
      switches: attempt.executor_id !== selected.id ? 1 : 0,
    };

    const outcome = this.retryStore.acceptDirectiveAndAllocateTarget(
      attemptId, cardId, classification, existingDecision.decision, directive,
      revisedContract, targetAttemptId, selected.kind, selected.id,
      earliestClaimAt, budgetReservation,
      {
        id: targetAttemptId,
        card_id: cardId,
        contract_id: revisedContract.id,
        ordinal: targetOrdinal,
        executor_kind: selected.kind,
        executor_id: selected.id,
        status: "pending",
        started_at: startedAt,
        source_attempt_id: attemptId,
        earliest_claim_at: earliestClaimAt,
      },
    );

    if (outcome.kind === "created") return { kind: "created" as const, targetAttemptId };
    if (outcome.kind === "idempotent") return { kind: "idempotent" as const, targetAttemptId };
    return outcome as AcceptRetryResult;
  }

  getReviewPacket(attemptId: string, cardId: number): RetryReviewPacket | { error: string } {
    const classification = this.retryStore.getClassification(attemptId);
    const decision = this.retryStore.getDecision(attemptId);
    const directive = this.retryStore.getDirective(attemptId);
    const contract = this.supService.getContractForCard(cardId);
    const latestAttempt = this.supStore.getAttempt(attemptId);
    const result = this.supStore.getResultByAttempt(attemptId);

    if (!classification || !decision || !contract || !latestAttempt) {
      return { error: "incomplete data for review packet" };
    }

    const candidates = this.executorCatalog.getCandidates({
      requiredCapabilities: [...contract.required_capabilities],
    });

    return {
      classification,
      decision: decision.decision,
      directive,
      contract,
      latestAttempt,
      envelope: result?.envelope,
      candidateSummary: candidates.eligible.map(c => `${c.id}(${c.kind})`).join(", "),
    };
  }

  getRetryState(sourceAttemptId: string): {
    classification?: FailureClassificationV1;
    decision?: { decision: RetryPolicyDecision; status: string };
    directive?: RetryDirectiveV1;
  } {
    return this.retryStore.getLineage(sourceAttemptId);
  }

  recoverPendingReviews(now: string): Array<{ attemptId: string; status: string }> {
    this.retryStore.expireOverdueReviews(now);
    return this.retryStore.getPendingReviewDecisions();
  }

  private getPreviousExecutors(cardId: number): string[] {
    const attempts = this.supStore.getAttemptsForCard(cardId);
    return attempts.map(a => a.executor_id);
  }

  private generateAttemptId(): string {
    const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
    return "a_" + randomBytes(12).toString("hex");
  }
}

function mapDispositionToStatus(d: RetryDisposition): DecisionStatus {
  switch (d) {
    case "automatic_retry": return "scheduled";
    case "orc_review": return "review_required";
    case "needs_input": return "needs_input";
    case "stop": return "stopped";
  }
}
