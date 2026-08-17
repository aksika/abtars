/**
 * scheduled-project-fixture.ts — #1548 test-only scriptable external
 * Orc/provider boundary for scheduled projects.
 *
 * Retains the real scheduled runner, CronQueue reservation, review store,
 * Kanban database, executor leases, wake sources, and shared settlement path.
 * Only the Orc "model turn" (startPort) is scripted: it writes the same
 * durable rows a real Orc would — acceptance contract, supervision state,
 * worker cards, review case, and terminal decision.
 *
 * The harness resets modules per test (vi.resetModules + ABTARS_HOME tmpdir),
 * so every production module is injected by the journey rather than imported
 * here.
 */

import type { OrcProjectCoordinator } from "../../components/orc-project/orc-project-coordinator.js";
import type { OrcInvocationContextV1 } from "../../components/orc-project/orc-project-contracts.js";
import type { ProjectAcceptanceContractV1 } from "../../components/project-acceptance/project-contract.js";

export interface FixtureModules {
  OrcProjectCoordinator: typeof import("../../components/orc-project/orc-project-coordinator.js").OrcProjectCoordinator;
  ProjectReviewStore: typeof import("../../components/project-acceptance/project-review-store.js").ProjectReviewStore;
  kanban: typeof import("../../components/tasks/kanban-board.js");
  nerve: typeof import("../../components/nerve.js").nerve;
  WorkerSupervisionService: typeof import("../../components/worker-supervision-service.js").WorkerSupervisionService;
  WorkerSupervisionStore: typeof import("../../components/worker-supervision-store.js").WorkerSupervisionStore;
}

export type FailOrcMode = "empty" | "terminal_tool" | "round_limit" | null;

export interface ScheduledProjectScript {
  /** Assert the admitted root is in a valid lifecycle state (Stage-1 subset). */
  reach(state: "executing" | "awaiting_contract" | "review_requested" | "needs_input"): Promise<{ runId: string; rootCardId: number }>;
  /** The scripted Orc dies on its next authoring/review turn. */
  failOrc(mode: FailOrcMode): void;
  /** Complete every running worker card as done. */
  completeWorkers(): void;
  /** Fail every running worker card. */
  failWorkers(): void;
  /** Insert an open review case and settle it accepted (fires card:done). */
  accept(): void;
  /** Insert an open review case and settle it blocked (fires card:failed). */
  block(reason: string): void;
  /** Mark the supervised root retryable (status queued + durable next_retry_at). */
  retryRoot(error: string): void;
  /** Adopt an existing root card (reattach cells where the fixture never authored). */
  adoptRoot(rootCardId: number): void;
  /** Scripted review-turn behavior: accept, demand input, or die. */
  setReviewMode(mode: "accept" | "needs_input" | "blocked" | "repair" | "die"): void;
  /** Answer the pending input request. */
  answerInput(text: string): void;
  /**
   * #1644: claim an Orc run for the project now (the stale-turn holder) and
   * pause the turn before any spawn. The claimed run is what a terminal
   * settlement must supersede; releaseStaleSpawn() then proves the paused
   * spawn loses its project authority.
   */
  armStaleSpawn(goal: string): { runId: string; projectGeneration: number } | { error: string };
  /** #1644: release the paused stale spawn after terminal settlement — the
   *  child creation must be rejected by the project authority (typed error,
   *  no durable child/contract/attempt). */
  releaseStaleSpawn(): { rejected: boolean; error?: string };
  /** #1644: submit a late worker result after terminal settlement — must be
   *  rejected as stale by the attempt/project authority. */
  submitLateWorkerResult(cardId: number, attemptId: string): { settled: boolean; summary: string; stale?: boolean; budgetViolation?: boolean };
  holdAcceptance: boolean;
  /** Last scripted turn outcome. */
  lastTurn: "authored" | "reviewed" | "input_requested" | "failed" | "none";
}

export interface ScheduledProjectFixtureOptions {
  /** Workers spawned at contract authoring; kept running until completed. */
  workerCount?: number;
  /** When set, the authoring turn dies without writing the contract. */
  failOrcMode?: FailOrcMode;
  /** When set, accept() refuses to settle (acceptance held). */
  holdAcceptance?: boolean;
  /** Scripted review-turn decision. */
  reviewMode?: "accept" | "needs_input" | "blocked" | "repair" | "die";
  /** Limits carried into every authored worker contract. */
  workerLimits?: { max_duration_ms?: number; max_tokens?: number };
  /** #1656: author a v2 root contract with an optional second delegated
   *  criterion (c2). Worker 0 maps to c1; every later worker maps to c2. */
  v2RootContract?: boolean;
}

const DEFAULT_OPTIONS = {
  workerCount: 1,
  failOrcMode: null as FailOrcMode,
  holdAcceptance: false,
  reviewMode: "accept" as "accept" | "needs_input" | "blocked" | "repair" | "die",
  workerLimits: undefined as { max_duration_ms?: number; max_tokens?: number } | undefined,
  v2RootContract: false,
};

export function makeScheduledProjectFixture(
  modules: FixtureModules,
  opts: ScheduledProjectFixtureOptions = {},
): { fixture: ScheduledProjectScript; orc: OrcProjectCoordinator } {
  const { OrcProjectCoordinator: OrcCtor, ProjectReviewStore: ReviewStore, kanban, nerve, WorkerSupervisionService: WorkerSvc, WorkerSupervisionStore: WorkerStore } = modules;
  const options: typeof DEFAULT_OPTIONS = { ...DEFAULT_OPTIONS, ...opts };
  const state = {
    holdAcceptance: options.holdAcceptance,
    failOrcMode: options.failOrcMode,
    reviewMode: options.reviewMode,
    lastTurn: "none" as ScheduledProjectScript["lastTurn"],
    admittedRoot: undefined as number | undefined,
    staleSpawn: undefined as { goal: string; context: OrcInvocationContextV1 } | undefined,
  };

  const workersOfRoot = (): ReturnType<typeof kanban.kanbanGetChildren> => {
    if (state.admittedRoot === undefined) return [];
    return kanban.kanbanGetChildren(state.admittedRoot).filter(c => c.type === "W");
  };

  const reviewAndDecide = (kind: "accept" | "block", reason?: string): void => {
    const rootId = state.admittedRoot!;
    const store = new ReviewStore();
    const supervision = store.getSupervision(rootId);
    if (!supervision) throw new Error(`fixture: no supervision for root #${rootId}`);
    // #1554: the driver may have settled the project already (review dispatch
    // is driver-owned); an explicit fixture accept after that is a no-op.
    if (supervision.state === "accepted" || supervision.state === "blocked") return;
    const round = supervision.review_round + 1;
    const snapshot = { summary: "all worker outcomes terminal" };
    const { id: caseId } = store.insertReviewCase(rootId, supervision.generation, round, snapshot, `sd_${rootId}_${round}`);
    if (kind === "accept") {
      store.settleAcceptance(rootId, caseId, { action: "accept", synthesis: "fixture acceptance" }, "fixture accepted");
      try { nerve.fire("card:done", rootId); } catch { /* best effort */ }
    } else {
      store.settleBlocked(rootId, caseId, { action: "blocked", reason: reason ?? "fixture blocked" }, reason ?? "fixture blocked");
      try { nerve.fire("card:failed", rootId); } catch { /* best effort */ }
    }
  };

  const terminalizeAttempts = (cardId: number, lifecycle: "completed" | "failed"): void => {
    try {
      const store = new WorkerStore();
      for (const attempt of store.getAttemptsForCard(cardId)) {
        store.lifecycleTransition(attempt.id, ["pending", "claimed", "running"], lifecycle);
      }
    } catch { /* best effort */ }
  };

  const script: ScheduledProjectScript = {
    get holdAcceptance(): boolean {
      return state.holdAcceptance;
    },
    set holdAcceptance(v: boolean) {
      state.holdAcceptance = v;
    },
    get lastTurn(): ScheduledProjectScript["lastTurn"] {
      return state.lastTurn;
    },
    reach: async (stateName) => {
      const rootCardId = state.admittedRoot;
      if (!rootCardId) throw new Error("fixture.reach: admission has not completed");
      const card = kanban.kanbanGetCard(rootCardId);
      const runId = card?.source_id ?? undefined;
      if (!runId) throw new Error(`fixture.reach: root #${rootCardId} has no run source_id`);
      const actual = new ReviewStore().getSupervision(rootCardId)?.state ?? "none";
      if (actual !== stateName) {
        throw new Error(`fixture.reach("${stateName}"): supervision is ${actual}, not ${stateName} — invalid fixture shape`);
      }
      return { runId, rootCardId };
    },
    failOrc: (mode) => { state.failOrcMode = mode; },
    completeWorkers: () => {
      for (const child of workersOfRoot()) {
        kanban.kanbanComplete(child.id, null, "worker complete");
        terminalizeAttempts(child.id, "completed");
      }
    },
    failWorkers: () => {
      for (const child of workersOfRoot()) {
        kanban.kanbanFail(child.id, "worker failed");
        terminalizeAttempts(child.id, "failed");
      }
    },
    accept: () => {
      if (state.holdAcceptance) return;
      reviewAndDecide("accept");
    },
    block: (reason) => {
      reviewAndDecide("block", reason);
    },
    retryRoot: (error) => {
      // kanbanRetryOrFail computes the exponential backoff (10s base, capped
      // 300s) and persists status=queued + next_retry_at — the durable retry
      // continuation the wake sources serve. Cells control the due time by
      // advancing the journey clock.
      if (state.admittedRoot === undefined) throw new Error("fixture.retryRoot: no admitted root");
      kanban.kanbanRetryOrFail(state.admittedRoot, error);
    },
    adoptRoot: (rootCardId) => {
      state.admittedRoot = rootCardId;
    },
    setReviewMode: (mode) => {
      state.reviewMode = mode;
    },
    answerInput: (text) => {
      if (state.admittedRoot === undefined) throw new Error("fixture.answerInput: no admitted root");
      const store = new ReviewStore();
      const pending = store.getPendingInputRequestsForProject(state.admittedRoot);
      if (pending.length === 0) throw new Error(`fixture.answerInput: no pending input for root #${state.admittedRoot}`);
      for (const req of pending) store.answerInputRequest(req.id, text);
    },
    armStaleSpawn: (goal) => {
      const rootId = state.admittedRoot;
      if (rootId === undefined) return { error: "armStaleSpawn: no admitted root" };
      const supervision = new ReviewStore().getSupervision(rootId);
      if (!supervision) return { error: "armStaleSpawn: no supervision" };
      const claim = orc.getStore().claimIntent({
        projectCardId: rootId,
        intentKind: "operator_turn",
        intentRef: `stale-${Date.now()}`,
        originKind: "local",
        sourcePeer: null,
        cardSource: "local",
        expectedProjectGeneration: supervision.generation,
      }, "test-fixture", "fixture-stale-holder");
      if (claim.kind !== "claimed" && claim.kind !== "idempotent") {
        return { error: `armStaleSpawn: claim rejected (${claim.kind})` };
      }
      state.staleSpawn = { goal, context: claim.context };
      return { runId: claim.context.runId, projectGeneration: claim.context.projectGeneration };
    },
    releaseStaleSpawn: () => {
      const stale = state.staleSpawn;
      const rootId = state.admittedRoot;
      if (!stale || rootId === undefined) return { rejected: false, error: "releaseStaleSpawn: no armed stale spawn" };
      const svc = new WorkerSvc();
      const result = svc.createChild(stale.goal, rootId, "stale-orc", {
        criteria: [{ id: "stale_c1", description: "stale handoff criterion" }],
        expectedArtifacts: [{ id: "stale_a1", kind: "file", ref: "out/stale.md", required: true, criterion_ids: ["stale_c1"] }],
        supportsRootCriteria: ["c1"],
        // The stale turn is bound to the generation it claimed — never the
        // project's current durable state.
        authority: { projectCardId: rootId, projectGeneration: stale.context.projectGeneration },
      });
      const rejected = "error" in result;
      if (rejected) state.staleSpawn = undefined;
      return { rejected, error: "error" in result ? result.error : undefined };
    },
    submitLateWorkerResult: (cardId, attemptId) => {
      const attempt = new WorkerStore().getAttempt(attemptId);
      const svc = new WorkerSvc();
      return svc.collectAndSettle(cardId, "<summary>late result</summary>", undefined, attemptId, attempt?.generation ?? 1);
    },
  };

  const orc = new OrcCtor({
    ownerPeer: "test-fixture",
    startPort: async (context: OrcInvocationContextV1, goal: string): Promise<void> => {
      const projectId = context.projectCardId;
      state.admittedRoot = projectId;
      const store = new ReviewStore();
      const supervision = store.getSupervision(projectId);
      // Each scripted turn mirrors a complete real Orc session: it claims the
      // intent (via the real run store), performs its durable writes, then
      // releases the claim so the next intent can be promoted.
      const finish = (outcome: "completed" | "failed"): void => {
        try { orc.getStore().release(context, outcome); } catch { /* best effort */ }
      };
      if (!supervision || supervision.state === "awaiting_contract") {
        if (state.failOrcMode) {
          state.lastTurn = "failed";
          finish("failed");
          return; // the Orc dies before producing the contract
        }
        const contract = buildContract(projectId, goal, options.v2RootContract ?? false);
        store.insertContract(contract);
        store.initializeSupervision(projectId, contract.id);
        for (let i = 0; i < options.workerCount; i++) {
          const workerId = kanban.kanbanEnqueue(`fixture-worker-${i}`, "agent", undefined, {
            parent_id: projectId,
            type: "W",
            goal: `Work lane ${i}`,
            delivery: "silent",
          });
          if (workerId !== 0) {
            kanban.kanbanRunning(workerId);
            // R5: a valid worker-owned executing state carries a contract and
            // a claimed running attempt, not just a running card.
            try {
              const svc = new WorkerSvc();
              const created = svc.createChild(`Work lane ${i}`, projectId, "fixture-orc", {
                cardId: workerId,
                criteria: [{ id: `w${i}`, description: "lane done" }],
                expectedArtifacts: [{ id: `a${i}`, kind: "file", ref: `out/lane-${i}.md`, required: true, criterion_ids: [`w${i}`] }],
                supportsRootCriteria: [options.v2RootContract ? (i === 0 ? "c1" : "c2") : "c1"],
                limits: options.workerLimits,
                attemptId: `att_fixture_${workerId}`,
              });
              if (!("error" in created)) {
                const pending = new WorkerStore().getAttempt(created.attemptId);
                const claim = pending
                  ? new WorkerStore().claimAttempt(workerId, created.contract.id, pending.executor_kind, pending.executor_id, 1)
                  : null;
                if (claim) new WorkerStore().markAttemptRunning(claim.attemptId);
              }
            } catch { /* best effort — the card alone still carries custody */ }
          }
        }
        state.lastTurn = "authored";
        finish("completed");
        return;
      }
      // Review turn (goal from scheduleReview / dispatchPendingReviewRequests):
      // decide accept, needs_input, or die according to the script.
      if (state.failOrcMode || state.reviewMode === "die") {
        state.lastTurn = "failed";
        finish("failed");
        return;
      }
      const openCase = store.getLatestOpenCase(projectId);
      if (!openCase) {
        state.lastTurn = "failed"; // no review case to decide — nothing owned
        finish("failed");
        return;
      }
      if (state.reviewMode === "repair") {
        // #1673: production ordering — the review tool settles the repair
        // inside the turn (advancing the supervision generation), and the
        // turn's terminal release happens afterwards. release() is terminal
        // cleanup of the run's own row; it must not run before the settle,
        // which is exactly the ordering that wedged the global Orc slot.
        store.settleRepair(projectId, openCase.id, {
          action: "repair",
          repair: { items: [{ id: "r1", affected_criterion_ids: ["c1"], strategy: "rework", required_evidence: "synthesis", capabilities: [], budget: { max_attempts: 1 } }] },
        }, supervision.generation, 0);
        // The reconciler would spawn repair workers via spin.spawnChild; the
        // fixture creates the valid repair worker rows directly.
        const repairWorkerId = kanban.kanbanEnqueue("fixture-repair-worker", "agent", undefined, {
          parent_id: projectId,
          type: "W",
          goal: "Repair: rework",
          delivery: "silent",
        });
        if (repairWorkerId !== 0) {
          kanban.kanbanRunning(repairWorkerId);
          try {
            const svc = new WorkerSvc();
            const created = svc.createChild("Repair: rework", projectId, "fixture-orc", {
              cardId: repairWorkerId,
              criteria: [{ id: "w1", description: "repair done" }],
              expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/repair.md", required: true, criterion_ids: ["w1"] }],
              // #1604: the repair item names the affected root criterion.
              supportsRootCriteria: ["c1"],
              limits: options.workerLimits,
              attemptId: `att_fixture_repair_${repairWorkerId}`,
            });
            if (!("error" in created)) {
              const pending = new WorkerStore().getAttempt(created.attemptId);
              const claim = pending
                ? new WorkerStore().claimAttempt(repairWorkerId, created.contract.id, pending.executor_kind, pending.executor_id, 1)
                : null;
              if (claim) new WorkerStore().markAttemptRunning(claim.attemptId);
            }
          } catch { /* best effort */ }
        }
        state.lastTurn = "reviewed";
        finish("completed");
        return;
      }
      if (state.reviewMode === "blocked") {
        store.settleBlocked(projectId, openCase.id, { action: "blocked", reason: "fixture review blocked" }, "fixture review blocked");
        try { nerve.fire("card:failed", projectId); } catch { /* best effort */ }
        state.lastTurn = "reviewed";
        finish("completed");
        return;
      }
      if (state.reviewMode === "needs_input") {
        store.settleNeedsInput(projectId, openCase.id, { action: "needs_input" }, {
          question: "confirm the deliverable scope",
          affectedCriterionIds: ["c1"],
          expectedResponseKind: "text",
        });
        state.lastTurn = "input_requested";
        finish("completed");
        return;
      }
      if (state.holdAcceptance) {
        // #1554: with the Reconciler live, review dispatch is driver-owned —
        // the scripted turn must honor the hold: release the claim without a
        // decision; the ownership-released event re-wakes and re-dispatches
        // once the hold clears.
        finish("completed");
        return;
      }
      store.settleAcceptance(projectId, openCase.id, { action: "accept", synthesis: "orc review accept" }, "orc review accept");
      try { nerve.fire("card:done", projectId); } catch { /* best effort */ }
      state.lastTurn = "reviewed";
      finish("completed");
    },
  });

  return { fixture: script, orc };
}

function buildContract(projectCardId: number, goal: string, v2RootContract = false): ProjectAcceptanceContractV1 {
  if (v2RootContract) {
    return {
      schema_version: 2,
      id: `fixture_contract_${projectCardId}_${Date.now()}`,
      digest: `fixture_digest_${projectCardId}`,
      project_card_id: projectCardId,
      goal: goal.slice(0, 500),
      criteria: [
        { id: "c1", description: "Task goal met", required: true, execution_owner: "delegated", evidence_expectation: "synthesis" },
        { id: "c2", description: "Optional extra lane", required: false, execution_owner: "delegated", evidence_expectation: "synthesis" },
      ],
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 1, max_repair_rounds: 1 },
      provenance: { requested_by: "scheduler", authored_by: "fixture-orc", created_at: new Date().toISOString() },
    } as unknown as ProjectAcceptanceContractV1;
  }
  const id = `fixture_contract_${projectCardId}_${Date.now()}`;
  return {
    schema_version: 1,
    id,
    digest: `fixture_digest_${projectCardId}`,
    project_card_id: projectCardId,
    goal: goal.slice(0, 500),
    criteria: [
      { id: "c1", description: "Task goal met", required: true, evidence_expectation: "synthesis" },
    ],
    required_outputs: [],
    constraints: [],
    limits: { max_review_rounds: 1, max_repair_rounds: 1 },
    provenance: { requested_by: "scheduler", authored_by: "fixture-orc", created_at: new Date().toISOString() },
  };
}
