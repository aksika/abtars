/**
 * scheduled-project-fixture.ts — #1792 test-only scriptable provider/executor
 * boundary for scheduled projects.
 *
 * Composition mirrors `orc-workflow.e2e.test.ts`: the REAL production chain
 * stays intact — scheduled admission (`WorkflowRunner.admitSupervised` via the
 * real `scheduledProjectRunner`), the shared WorkflowStore/task database,
 * worker creation/binding (`WorkflowWorkerPort`), result commit
 * (`collectAndSettle`/`terminalSettlement` joint commit into the runner),
 * review (`submitVerdict`), delivery obligations, terminal projections, and
 * the scheduled settler. Deterministic fixtures replace ONLY the model
 * responses (plan proposal + review verdict content, chosen by this script at
 * the planner/reviewer boundary) and worker execution (the reconciler
 * generation's pass-through adapter holds claims; this fixture settles them).
 *
 * Retired #1792: the old scripted Orc turn (direct contract/supervision/worker
 * DB writes + `kanbanComplete`/`lifecycleTransition` advancement). Nothing
 * here writes project phase, supervision state, review cases/decisions, or
 * worker lifecycles directly — those are runner/settlement-owned now.
 */

import { WorkflowRunner } from "../../components/orc-project/orc-workflow-runner.js";
import type {
  PlanProposal,
  PlannerBackend,
  PlanningInput,
  ReviewBackend,
  ReviewBrief,
  ReviewVerdict,
} from "../../components/orc-project/orc-workflow-runner.js";
import { WorkflowStore } from "../../components/orc-project/orc-workflow-store.js";
import type { CommandRow } from "../../components/orc-project/orc-workflow-store.js";
import { WorkflowWorkerPort } from "../../components/orc-project/orc-workflow-ports.js";
import type { OrcProjectCoordinator } from "../../components/orc-project/orc-project-coordinator.js";
import type { ExecutorKind } from "../../components/worker-executor-identity.js";
import type { OrcInvocationContextV2 } from "../../components/orc-project/orc-project-contracts.js";

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
  /** Assert the admitted run reached a lifecycle state (runner-native). */
  reach(state: "executing" | "awaiting_contract" | "review_requested" | "needs_input"): Promise<{ runId: string; rootCardId: number }>;
  /** The scripted planner dies on its next planning turn. */
  failOrc(mode: FailOrcMode): void;
  /** Settle every dispatched worker lane completed (real result commit). */
  completeWorkers(): void;
  /** Settle every dispatched worker lane failed (real result commit). */
  failWorkers(): void;
  /** #1751: settle one worker lane completed by index (node order). */
  completeWorker(index: number): void;
  /** #1751: settle one worker lane failed by index (node order). */
  failWorker(index: number): void;
  /** Submit accept on the open review node (no-op when held or already terminal). */
  accept(): void;
  /** Submit cannot_assess on the open review node (no-op when already terminal). */
  block(reason: string): void;
  /** Mark the supervised root retryable (status queued + durable next_retry_at). */
  retryRoot(error: string): void;
  /** Adopt an existing root card (pin discovery to it). */
  adoptRoot(rootCardId: number): void;
  /** Scripted review-turn behavior: accept, demand input, or die. */
  setReviewMode(mode: "accept" | "needs_input" | "blocked" | "repair" | "die"): void;
  /** Answer the pending input request, then submit the resume-accept verdict. */
  answerInput(text: string): void;
  /**
   * #1644: claim an Orc run for the project now (the stale-turn holder) and
   * keep it. The claimed run is what a terminal settlement supersedes or
   * fences; releaseStaleSpawn() then proves the stale spawn loses its
   * project authority.
   */
  armStaleSpawn(goal: string): { runId: string; projectGeneration: number } | { error: string };
  /** #1644: attempt the stale spawn after terminal settlement — the child
   *  creation must be rejected by the project authority (typed error,
   *  no durable child/contract/attempt). */
  releaseStaleSpawn(): { rejected: boolean; error?: string };
  /** #1644: submit a late worker result after terminal settlement — must be
   *  rejected as stale by the attempt/project authority. */
  submitLateWorkerResult(cardId: number, attemptId: string): { settled: boolean; summary: string; stale?: boolean; budgetViolation?: boolean };
  holdAcceptance: boolean;
  /** Last scripted boundary outcome. */
  lastTurn: "authored" | "reviewed" | "input_requested" | "failed" | "none";
}

export interface ScheduledProjectFixtureOptions {
  /** Work lanes in the scripted initial plan; settled via the fixture. */
  workerCount?: number;
  /** When set, the scripted planner dies without proposing. */
  failOrcMode?: FailOrcMode;
  /** When set, accept() refuses to settle (acceptance held). */
  holdAcceptance?: boolean;
  /** Scripted review-turn decision. */
  reviewMode?: "accept" | "needs_input" | "blocked" | "repair" | "die";
  /** Limits patched into every dispatched worker contract (scripted contract shaping). */
  workerLimits?: { max_duration_ms?: number; max_tokens?: number };
  /** #1656: script a v2-shaped plan with an optional second lane (lane 1
   *  optional; every later lane maps to the optional input). */
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

/** Acceptance strings the scripted plan publishes (defect linkage reads these back). */
const LANE_ACCEPTANCE = "lane delivers its committed output";
const REPAIR_ACCEPTANCE = "repair rework delivers its committed output";

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
    limitsPatchedForRun: undefined as string | undefined,
    staleSpawn: undefined as { goal: string; context: OrcInvocationContextV2 } | undefined,
  };

  const store = new WorkflowStore();
  const runner = new WorkflowRunner(store);

  // ── scripted provider boundary (proposal/verdict content only) ──────────
  // Synchronous like orc-workflow.e2e's scriptedPorts: the model TEXT is
  // faked; identities, budgets, authority, and result application stay in the
  // runner. Production backends (SpinPlannerBackend/SpinReviewerBackend +
  // callModel, wired in orc-workflow-driver.ts) remain the live path.

  /** The per-lane file outputs of the scripted initial plan. */
  function laneOutputs(): string[] {
    return Array.from({ length: Math.max(1, options.workerCount) }, (_, i) => `out/lane-${i}.md`);
  }

  function initialProposal(): PlanProposal {
    const count = Math.max(1, options.workerCount);
    // Each lane declares its own file output (ref `out/lane-<i>.md`): the
    // port turns declared outputs into required file artifacts, so lane
    // evidence is per-lane files the settler can observe. No logical outputs:
    // a pathless output observes as missing and would fail every lane.
    const lanes = Array.from({ length: count }, (_, i) => ({
      label: `lane-${i}`,
      kind: "work" as const,
      instructions: `Work lane ${i}`,
      capability: "general",
      outputs: [`out/lane-${i}.md`],
      acceptance: [LANE_ACCEPTANCE],
      dependsOn: [] as string[],
      ...(options.v2RootContract && i > 0 ? { optional: true } : {}),
    }));
    return {
      requiredOutputs: laneOutputs(),
      nodes: [
        ...lanes,
        {
          label: "review",
          kind: "review" as const,
          instructions: "judge the candidate revision",
          capability: "general",
          outputs: [] as string[],
          acceptance: [] as string[],
          dependsOn: lanes.map((l) => l.label),
        },
      ],
    };
  }

  function repairProposal(): PlanProposal {
    return {
      // Same required outputs as the initial plan (monotonic acceptance);
      // coverage carries from the cumulative prior outputs. The repair lane
      // re-declares the lane files (contract validation requires an evidence
      // path per criterion); unsettled evidence only fails the lane's
      // criteria, never the completion itself.
      requiredOutputs: laneOutputs(),
      nodes: [
        {
          label: "fix",
          kind: "work" as const,
          instructions: "repair rework",
          capability: "general",
          outputs: laneOutputs(),
          acceptance: [REPAIR_ACCEPTANCE],
          dependsOn: [] as string[],
        },
      ],
    };
  }

  /** Complete a drain-claimed job command inline (the scripted model already answered). */
  function completeClaim(cmd: CommandRow, owner: string): void {
    const live = store.getCommand({
      runId: cmd.runId, generation: cmd.generation,
      nodeId: cmd.nodeId, action: cmd.action, ordinal: cmd.ordinal,
    });
    if (live && live.status === "claimed") {
      store.completeCommand(
        {
          runId: cmd.runId, generation: cmd.generation,
          nodeId: cmd.nodeId, action: cmd.action, ordinal: cmd.ordinal,
        },
        live.owner ?? owner,
        live.claimToken ?? "",
      );
    }
  }

  const planner: PlannerBackend = {
    name: "fixture-planner",
    startPlanning(cmd: CommandRow, input: PlanningInput): void {
      if (state.failOrcMode) {
        state.lastTurn = "failed";
        return; // the planner dies before proposing — the claim hangs for inspection
      }
      const proposal = input.purpose === "repair" ? repairProposal() : initialProposal();
      const current = store.currentRevision(cmd.runId);
      runner.submitPlanProposal(cmd.runId, proposal, {
        baseRevision: input.purpose === "initial" ? undefined : (input.revision ?? current),
        opId: input.opId,
      });
      state.lastTurn = input.purpose === "initial" ? "authored" : "reviewed";
      completeClaim(cmd, "fixture-planner");
    },
  };

  const reviewer: ReviewBackend = {
    name: "fixture-reviewer",
    startReview(cmd: CommandRow, _brief: ReviewBrief): void {
      if (state.failOrcMode || state.reviewMode === "die") {
        state.lastTurn = "failed";
        return; // dead reviewer turn — the claim hangs for inspection
      }
      if (state.reviewMode === "needs_input") {
        runner.requestInput(cmd.runId, "confirm the deliverable scope", [LANE_ACCEPTANCE]);
        state.lastTurn = "input_requested";
        return;
      }
      if (state.reviewMode === "accept" && state.holdAcceptance) {
        return; // held: the verdict stays pending until fixture.accept()
      }
      const verdict: ReviewVerdict = state.reviewMode === "accept"
        ? { verdict: "accept" }
        : state.reviewMode === "blocked"
          ? { verdict: "cannot_assess", reason: "fixture review blocked" }
          : {
              verdict: "changes_required",
              defects: [{ criterion: LANE_ACCEPTANCE, detail: "synthesis missing sources" }],
            };
      runner.submitVerdict(cmd.runId, cmd.nodeId, verdict);
      state.lastTurn = "reviewed";
      completeClaim(cmd, "fixture-reviewer");
    },
  };

  const ports = {
    executor: new WorkflowWorkerPort({ runner }),
    reviewer,
    planner,
    delivery: {
      name: "fixture-delivery",
      send: () => "fixture-receipt",
    },
  };

  // Guarded reentrant pump: nerve wakes fire synchronously inside drain
  // (child creation, projections), so nested pumps collapse into one loop.
  // Loops until a pass dispatches nothing — verdicts queue repair/delivery
  // work mid-drain with no nerve wake, so one pump() fully converges.
  let pumping = false;
  let repump = false;
  function pump(): void {
    if (pumping) {
      repump = true;
      return;
    }
    pumping = true;
    try {
      for (let pass = 0; pass < 25; pass++) {
        repump = false;
        let dispatched = 0;
        try {
          dispatched = runner.drain(50, ports);
        } catch (err) {
          // Port errors resolve into run state (failed/refused), never throw
          // past the fixture pump; journeys assert the durable outcome. Log
          // boundedly so a wedged dispatch is diagnosable, not silent.
          try {
            process.stderr.write(`fixture-pump: contained ${err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300)}\n`);
          } catch {
            // Logging must never break the pump.
          }
        }
        if (!repump && dispatched === 0) break;
      }
    } finally {
      pumping = false;
    }
  }

  const onWake = (): void => {
    pump();
  };
  nerve.on("card:queued", onWake);
  nerve.on("card:done", onWake);
  nerve.on("card:failed", onWake);

  // ── run discovery + reads ───────────────────────────────────────────────

  /** The production-admitted scheduled run (the scheduled runner admits; the
   *  fixture discovers — never fabricates — the admission). */
  function discoverRoot(): number | undefined {
    if (state.admittedRoot !== undefined) return state.admittedRoot;
    try {
      const row = store.db
        .prepare(`SELECT root_card_id FROM workflow_runs WHERE root_kind = 'scheduled' ORDER BY rowid DESC LIMIT 1`)
        .get() as { root_card_id: number } | undefined;
      return row?.root_card_id;
    } catch {
      return undefined;
    }
  }

  function currentRun(): { runId: string; rootCardId: number; revision: number } | undefined {
    const rootCardId = discoverRoot();
    if (rootCardId === undefined) return undefined;
    const run = store.findLatestRunByCard(rootCardId);
    if (!run) return undefined;
    return { runId: run.runId, rootCardId, revision: store.currentRevision(run.runId) };
  }

  /** Patch scripted contract limits into dispatched worker contracts (#1588). */
  function patchWorkerLimits(runId: string, revision: number): void {
    if (!options.workerLimits || state.limitsPatchedForRun === runId) return;
    const wb = new WorkerStore();
    for (const node of store.listNodes(runId, revision)) {
      if (node["kind"] !== "work" && node["kind"] !== "synthesis") continue;
      const cardId = node["worker_card_id"] as number | null;
      if (cardId == null) continue;
      const contract = wb.getContractByCardId(cardId);
      if (!contract) continue;
      try {
        const parsed = JSON.parse(contract.contract_json) as Record<string, unknown>;
        parsed["limits"] = { ...(options.workerLimits as Record<string, number>) };
        wb.db.prepare(`UPDATE worker_contracts SET contract_json = ? WHERE id = ?`)
          .run(JSON.stringify(parsed), contract.id);
      } catch {
        // Best effort: the lane still settles; only the binding-limit fact is lost.
      }
    }
    state.limitsPatchedForRun = runId;
  }

  /** Open work/synthesis nodes of the current revision, in node order. */
  function openWorkNodes(): Array<{ nodeId: string; cardId: number | null }> {
    const cur = currentRun();
    if (!cur) return [];
    return store.listNodes(cur.runId, cur.revision)
      .filter((n) => (n["kind"] === "work" || n["kind"] === "synthesis")
        && (n["status"] === "queued" || n["status"] === "running"))
      .map((n) => ({ nodeId: n["node_id"] as string, cardId: n["worker_card_id"] as number | null }));
  }

  /** All work/synthesis nodes of the current revision, in node order. */
  function allWorkNodes(): Array<{ nodeId: string }> {
    const cur = currentRun();
    if (!cur) return [];
    return store.listNodes(cur.runId, cur.revision)
      .filter((n) => n["kind"] === "work" || n["kind"] === "synthesis")
      .map((n) => ({ nodeId: n["node_id"] as string }));
  }

  /** The open review node (newest revision first), if the run awaits a verdict. */
  function openReviewNode(): { runId: string; nodeId: string } | undefined {
    const cur = currentRun();
    if (!cur) return undefined;
    // A verdict is due only once the revision's work settled — never while
    // lanes are still dispatched (in particular, never a fresh accept while a
    // repair wave is outstanding).
    const openWork = store.listNodes(cur.runId, cur.revision).some(
      (n) => (n["kind"] === "work" || n["kind"] === "synthesis")
        && (n["status"] === "queued" || n["status"] === "running"),
    );
    if (openWork) return undefined;
    for (let rev = cur.revision; rev >= 1; rev--) {
      const found = store.listNodes(cur.runId, rev).find(
        (n) => n["kind"] === "review" && (n["status"] === "queued" || n["status"] === "running"),
      );
      if (found) return { runId: cur.runId, nodeId: found["node_id"] as string };
    }
    return undefined;
  }

  function workspaceCwd(rootCardId: number): string | undefined {
    try {
      return new ReviewStore().getWorkspaceScope(rootCardId)?.cwd;
    } catch {
      return undefined;
    }
  }

  /** Ensure the lane attempt is claimed so terminal settlement accepts it. */
  function ensureClaimed(cardId: number): { id: string; generation: number } {
    const wb = new WorkerStore();
    const latest = wb.getLatestAttempt(cardId);
    if (!latest) throw new Error(`fixture: no attempt for worker card #${cardId}`);
    if (latest.lifecycle === "pending") {
      try {
        const claim = wb.claimAttempt(
          cardId, latest.contract_id,
          latest.executor_kind as ExecutorKind,
          latest.executor_id,
          latest.generation || 1,
        );
        if (claim) wb.markAttemptRunning(claim.attemptId);
      } catch {
        // The reconciler pump may hold the claim — settlement reads the row.
      }
    }
    const fresh = wb.getLatestAttempt(cardId);
    if (!fresh) throw new Error(`fixture: attempt vanished for worker card #${cardId}`);
    return { id: fresh.id, generation: fresh.generation || 1 };
  }

  function settleLane(cardId: number, lifecycle: "completed" | "failed"): void {
    const cur = currentRun();
    const cwd = cur ? workspaceCwd(cur.rootCardId) : undefined;
    if (lifecycle === "completed") {
      const attempt = ensureClaimed(cardId);
      const outcome = new WorkerSvc().collectAndSettle(
        cardId, "<summary>lane finished</summary>", cwd, attempt.id, attempt.generation,
      );
      if (!outcome.settled) {
        throw new Error(`fixture.completeWorkers: lane #${cardId} refused settlement (${outcome.summary})`);
      }
      kanban.kanbanComplete(cardId, null, "worker complete");
      return;
    }
    const wb = new WorkerStore();
    const latest = wb.getLatestAttempt(cardId);
    if (!latest) throw new Error(`fixture.failWorkers: no attempt for worker card #${cardId}`);
    if (latest.lifecycle === "pending") ensureClaimed(cardId);
    const attempt = wb.getLatestAttempt(cardId);
    if (!attempt) throw new Error(`fixture.failWorkers: attempt vanished for worker card #${cardId}`);
    const settled = wb.terminalSettlement({
      attemptId: attempt.id, expectedGeneration: attempt.generation || 1,
      desiredState: "failed", stableReason: "worker failed",
    });
    if (settled.kind !== "settled" && settled.kind !== "replayed") {
      throw new Error(`fixture.failWorkers: lane #${cardId} refused failure settlement (${settled.kind})`);
    }
    kanban.kanbanFail(cardId, "worker failed");
  }

  function settleNode(nodeId: string, lifecycle: "completed" | "failed"): void {
    const cur = currentRun();
    if (!cur) throw new Error("fixture: no admitted run to settle workers for");
    pump();
    const node = store.listNodes(cur.runId, store.currentRevision(cur.runId))
      .find((n) => n["node_id"] === nodeId);
    const cardId = node?.["worker_card_id"] as number | null | undefined;
    if (cardId == null) throw new Error(`fixture: node ${nodeId} has no dispatched worker yet`);
    settleLane(cardId, lifecycle);
    pump();
  }

  function verdictOnOpen(action: "accept" | "cannot_assess", reason?: string): void {
    const open = openReviewNode();
    if (!open) {
      // The runner may have settled already (verdict committed by the
      // scripted reviewer, or the run terminalized another way) — explicit
      // fixture acceptance after that is a no-op.
      const cur = currentRun();
      if (cur && store.getRun(cur.runId) && ["succeeded", "failed", "cancelled"].includes(store.getRun(cur.runId)?.state ?? "")) return;
      throw new Error("fixture: no open review node and run is not terminal");
    }
    runner.submitVerdict(
      open.runId, open.nodeId,
      action === "accept" ? { verdict: "accept" } : { verdict: "cannot_assess", reason: reason ?? "fixture blocked" },
    );
    state.lastTurn = "reviewed";
    pump();
  }

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
      pump();
      const cur = currentRun();
      if (!cur) throw new Error("fixture.reach: admission has not completed");
      if (options.workerLimits) patchWorkerLimits(cur.runId, cur.revision);
      const card = kanban.kanbanGetCard(cur.rootCardId);
      const runId = card?.source_id ?? undefined;
      if (!runId) throw new Error(`fixture.reach: root #${cur.rootCardId} has no run source_id`);
      const run = store.getRun(cur.runId);
      // "executing" means planned AND dispatched: every work lane owns a
      // worker card (the old authoring turn spawned lanes atomically).
      const lanes = store.listNodes(cur.runId, cur.revision)
        .filter((n) => n["kind"] === "work" || n["kind"] === "synthesis");
      const dispatched = lanes.length > 0 && lanes.every((n) => (n["worker_card_id"] as number | null) != null);
      const matched = stateName === "executing"
        ? (cur.revision >= 1 && dispatched && run !== null && !["succeeded", "failed", "cancelled"].includes(run.state))
        : stateName === "awaiting_contract"
          ? cur.revision === 0
          : stateName === "needs_input"
            ? run?.state === "awaiting_input"
            : openReviewNode() !== undefined;
      if (!matched) {
        throw new Error(`fixture.reach("${stateName}"): run ${cur.runId} state=${run?.state ?? "none"} revision=${cur.revision} — invalid fixture shape`);
      }
      return { runId, rootCardId: cur.rootCardId };
    },
    failOrc: (mode) => { state.failOrcMode = mode; },
    completeWorkers: () => {
      for (const node of openWorkNodes()) {
        if (node.cardId == null) {
          pump();
          const reread = openWorkNodes().find((n) => n.nodeId === node.nodeId);
          if (reread?.cardId == null) throw new Error(`fixture.completeWorkers: node ${node.nodeId} has no dispatched worker yet`);
          settleLane(reread.cardId, "completed");
        } else {
          settleLane(node.cardId, "completed");
        }
      }
      pump();
    },
    failWorkers: () => {
      for (const node of openWorkNodes()) {
        if (node.cardId == null) {
          pump();
          const reread = openWorkNodes().find((n) => n.nodeId === node.nodeId);
          if (reread?.cardId == null) throw new Error(`fixture.failWorkers: node ${node.nodeId} has no dispatched worker yet`);
          settleLane(reread.cardId, "failed");
        } else {
          settleLane(node.cardId, "failed");
        }
      }
      pump();
    },
    completeWorker: (index) => {
      pump();
      const node = allWorkNodes()[index];
      if (!node) throw new Error(`fixture.completeWorker: no worker lane ${index}`);
      settleNode(node.nodeId, "completed");
    },
    failWorker: (index) => {
      pump();
      const node = allWorkNodes()[index];
      if (!node) throw new Error(`fixture.failWorker: no worker lane ${index}`);
      settleNode(node.nodeId, "failed");
    },
    accept: () => {
      if (state.holdAcceptance) return;
      verdictOnOpen("accept");
    },
    block: (reason) => {
      verdictOnOpen("cannot_assess", reason);
    },
    retryRoot: (error) => {
      // kanbanRetryOrFail computes the exponential backoff (10s base, capped
      // 300s) and persists status=queued + next_retry_at — the durable retry
      // continuation the wake sources serve. Cells control the due time by
      // advancing the journey clock.
      const root = discoverRoot();
      if (root === undefined) throw new Error("fixture.retryRoot: no admitted root");
      kanban.kanbanRetryOrFail(root, error);
    },
    adoptRoot: (rootCardId) => {
      state.admittedRoot = rootCardId;
    },
    setReviewMode: (mode) => {
      state.reviewMode = mode;
    },
    answerInput: (text) => {
      const root = discoverRoot();
      if (root === undefined) throw new Error("fixture.answerInput: no admitted root");
      const cur = currentRun();
      if (!cur) throw new Error("fixture.answerInput: no admitted run");
      const pending = new ReviewStore().getPendingInputRequestsForProject(root);
      if (pending.length === 0) throw new Error(`fixture.answerInput: no pending input for root #${root}`);
      // The scripted resume turn: answer through the runner (durable answer
      // row + executing resume), then accept on the still-open review node.
      for (const req of pending) runner.answerInput(req.id, text);
      state.lastTurn = "reviewed";
      verdictOnOpen("accept");
    },
    armStaleSpawn: (goal) => {
      const rootId = discoverRoot();
      if (rootId === undefined) return { error: "armStaleSpawn: no admitted root" };
      const supervision = new ReviewStore().getSupervision(rootId);
      if (!supervision) return { error: "armStaleSpawn: no supervision" };
      const claim = orc.getStore().claimIntent({
        projectCardId: rootId,
        intentKind: "operator_turn",
        intentRef: `stale-${Date.now()}`,
        goal: "stale operator turn",
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
      const rootId = discoverRoot();
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

  const orc = new OrcCtor({});

  return { fixture: script, orc };
}
