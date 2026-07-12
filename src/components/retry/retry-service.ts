import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import { WorkerSupervisionService } from "../worker-supervision-service.js";
import { ExecutorLeaseStore } from "../executor-lease-store.js";
import { RetryStore, type DecisionStatus } from "./retry-store.js";
import { classify } from "./failure-classifier.js";
import type { FailureClassificationV1 } from "./failure-classifier.js";
import { evaluatePolicy, computeBudget, computeElapsedMs } from "./retry-policy.js";
import type { RetryPolicyDecision, RetryDisposition } from "./retry-policy.js";
import { filterCandidates, selectExecutor } from "./executor-selector.js";
import type { ExecutorCandidate, SelectionConstraints } from "./executor-selector.js";
import { buildDirective, deriveContractRevision, validateDirective, validateContractRevision } from "./retry-directive.js";
import type { RetryDirectiveV1, RetryMode } from "./retry-directive.js";
import type { WorkerAcceptanceContractV1, WorkerResultEnvelopeV1 } from "../worker-contract.js";
import type { AttemptRow } from "../worker-supervision-store.js";

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

export class RetryService {
  private supStore: WorkerSupervisionStore;
  private supService: WorkerSupervisionService;
  private leaseStore: ExecutorLeaseStore;
  private retryStore: RetryStore;

  constructor() {
    this.supStore = new WorkerSupervisionStore();
    this.supService = new WorkerSupervisionService();
    this.leaseStore = new ExecutorLeaseStore();
    this.retryStore = new RetryStore();
  }

  handleTerminalAttempt(attemptId: string, cardId: number): { classification: FailureClassificationV1; decision: RetryPolicyDecision } | { error: string } {
    const attempt = this.supStore.getAttempt(attemptId);
    if (!attempt) return { error: `attempt ${attemptId} not found` };

    const contract = this.supService.getContractForCard(cardId);
    if (!contract) return { error: `no contract for card ${cardId}` };

    const resultRow = this.supStore.getResultByAttempt(attemptId);

    // Classify
    const { classification } = classify({
      attempt_id: attemptId,
      envelope: resultRow?.envelope,
      leaseSnapshot: this.leaseStore.getSnapshot(attemptId),
      lifecycle: attempt.lifecycle,
      lifecycleReason: attempt.cancel_reason ?? undefined,
      cancelReason: attempt.cancel_reason ?? undefined,
      hasPendingInput: false,
    } as any);

    this.retryStore.insertClassification(classification);

    // Compute budget
    const allAttempts = this.supStore.getAttemptsForCard(cardId);
    const sameClassCount = allAttempts.filter(a => {
      const c = this.retryStore.getClassification(a.id);
      return c?.primary === classification.primary;
    }).length;

    const previousExecutors: string[] = allAttempts.map(a => a.executor_id);
    const lastExecutor = previousExecutors[previousExecutors.length - 1];
    const consecutiveSameExecutorFails = lastExecutor
      ? allAttempts.filter(a => a.executor_id === lastExecutor && this.supStore.isAttemptTerminal(a.lifecycle)).length
      : 0;

    const elapsedMs = contract.provenance.created_at ? computeElapsedMs(contract.provenance.created_at) : 0;
    const budget = computeBudget(
      allAttempts.length,
      sameClassCount,
      consecutiveSameExecutorFails,
      previousExecutors.length > 1 ? new Set(previousExecutors.slice(0, -1)).size : 0,
      elapsedMs,
      resultRow?.envelope?.usage?.total_tokens ?? 0,
      0,
      attempt.hard_deadline_at ?? undefined,
    );

    // Get available executors
    const candidates: ExecutorCandidate[] = [
      { id: "spin", kind: "agent", capabilities: ["*"], healthy: true, load: 0 },
    ];
    const { eligible } = filterCandidates(candidates, { requiredCapabilities: [...(contract?.required_capabilities ?? [])] });

    // Policy decision
    const decision = evaluatePolicy({
      sourceAttemptId: attemptId,
      classification: { primary: classification.primary, retryability: classification.retryability, factors: classification.factors },
      budgets: budget,
      candidateExecutorIds: eligible.map(c => c.id),
      previousExecutors,
    });
    this.retryStore.insertDecision(decision, mapDispositionToStatus(decision.disposition));

    return { classification, decision };
  }

  buildAutomaticDirective(
    attemptId: string,
    cardId: number,
    classification: FailureClassificationV1,
    decision: RetryPolicyDecision,
  ): { directive: RetryDirectiveV1; reasonCode: string } | { error: string } {
    const contract = this.supService.getContractForCard(cardId);
    if (!contract) return { error: "no contract" };

    const attempt = this.supStore.getAttempt(attemptId);
    if (!attempt) return { error: "attempt not found" };

    const candidates: ExecutorCandidate[] = [
      { id: "spin", kind: "agent" as const, capabilities: ["*"], healthy: true, load: 0 },
    ];

    const { selected, rationale } = selectExecutor(
      candidates,
      { requiredCapabilities: [...contract.required_capabilities] },
      [attempt.executor_id],
    );
    if (!selected) return { error: "no eligible executor" };

    const targetOrdinal = this.supStore.nextOrdinal(cardId);

    const isTransient = classification.primary === "transient_transport" || classification.primary === "executor_unavailable";
    const mode: RetryMode = isTransient ? "clean_rerun" : "strategy_change";

    const instruction = isTransient
      ? `Clean rerun of original goal. Previous attempt ${attemptId} failed with transient ${classification.primary}. Use fresh session.`
      : `Retry with changed approach. Previous attempt ${attemptId} failed with ${classification.primary}. ${decision.reasonCode}`;

    const directive = buildDirective(
      contract,
      attemptId,
      targetOrdinal,
      classification,
      decision,
      rationale,
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

    this.retryStore.insertDirective(directive);
    if (decision.disposition === "automatic_retry") {
      this.retryStore.updateDecisionStatus(attemptId, "scheduled");
    }

    deriveContractRevision(contract, directive);

    return { directive, reasonCode: decision.reasonCode };
  }

  buildOrcDirective(
    attemptId: string,
    cardId: number,
    response: OrcRetryResponse,
  ): { directive: RetryDirectiveV1 | null; errors: string[] } | { error: string } {
    const existingDecision = this.retryStore.getDecision(attemptId);
    if (!existingDecision) return { error: `no decision for attempt ${attemptId}` };
    if (existingDecision.status === "consumed" || existingDecision.status === "stopped") {
      return { error: `decision already ${existingDecision.status}` };
    }

    const classification = this.retryStore.getClassification(attemptId);
    if (!classification) return { error: `no classification for attempt ${attemptId}` };

    const contract = this.supService.getContractForCard(cardId);
    if (!contract) return { error: "no contract" };

    const attempt = this.supStore.getAttempt(attemptId);
    if (!attempt) return { error: "attempt not found" };

    if (response.action === "stop") {
      this.retryStore.updateDecisionStatus(attemptId, "stopped");
      return { directive: null, errors: ["Orc chose stop"] };
    }

    if (response.action === "needs_input") {
      this.retryStore.updateDecisionStatus(attemptId, "needs_input");
      return { directive: null, errors: ["needs fresh input"] };
    }

    const candidates: ExecutorCandidate[] = [
      { id: "spin", kind: "agent" as const, capabilities: ["*"], healthy: true, load: 0 },
    ];

    const constraints: SelectionConstraints = {
      requiredCapabilities: [...contract.required_capabilities],
      preferredId: response.preferredExecutorId,
    };

    const { selected, rationale } = selectExecutor(candidates, constraints, [attempt.executor_id]);
    if (!selected) return { error: "no eligible executor from Orc preference" };

    const targetOrdinal = this.supStore.nextOrdinal(cardId);

    const mode: RetryMode = response.strategy?.includes("executor") ? "executor_escalation" : "repair";

    const directive = buildDirective(
      contract,
      attemptId,
      targetOrdinal,
      classification,
      existingDecision.decision,
      rationale,
      {
        mode,
        instruction: response.strategy ?? `Repair: ${classification.primary}`,
        doNotRepeat: response.doNotRepeat,
        addedInputs: response.addedInputs,
        addedChecks: response.addedChecks,
        authoredBy: "orc",
      },
    );

    const errors = validateDirective(directive);
    if (errors.length > 0) return { error: `directive validation failed: ${errors.join("; ")}` };

    const revisedContract = deriveContractRevision(contract, directive);
    const revErrors = validateContractRevision(contract, revisedContract);
    if (revErrors.length > 0) return { error: `contract revision invalid: ${revErrors.join("; ")}` };

    this.retryStore.insertDirective(directive);
    this.retryStore.updateDecisionStatus(attemptId, "scheduled");

    return { directive, errors: [] };
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

    const candidates: ExecutorCandidate[] = [
      { id: "spin", kind: "agent", capabilities: ["*"], healthy: true, load: 0 },
    ];

    return {
      classification,
      decision: decision.decision,
      directive,
      contract,
      latestAttempt,
      envelope: result?.envelope,
      candidateSummary: candidates.map(c => `${c.id}(${c.kind})`).join(", "),
    };
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
