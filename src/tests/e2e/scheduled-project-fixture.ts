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
}

export type FailOrcMode = "empty" | "terminal_tool" | "round_limit" | null;

export interface ScheduledProjectScript {
  /** Assert the admitted root is in a valid lifecycle state (Stage-1 subset). */
  reach(state: "executing" | "awaiting_contract"): Promise<{ runId: string; rootCardId: number }>;
  /** The scripted Orc dies on its next authoring turn. */
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
  holdAcceptance: boolean;
  /** Last scripted turn outcome. */
  lastTurn: "authored" | "failed" | "none";
}

export interface ScheduledProjectFixtureOptions {
  /** Workers spawned at contract authoring; kept running until completed. */
  workerCount?: number;
  /** When set, the authoring turn dies without writing the contract. */
  failOrcMode?: FailOrcMode;
  /** When set, accept() refuses to settle (acceptance held). */
  holdAcceptance?: boolean;
}

const DEFAULT_OPTIONS = {
  workerCount: 1,
  failOrcMode: null as FailOrcMode,
  holdAcceptance: false,
};

export function makeScheduledProjectFixture(
  modules: FixtureModules,
  opts: ScheduledProjectFixtureOptions = {},
): { fixture: ScheduledProjectScript; orc: OrcProjectCoordinator } {
  const { OrcProjectCoordinator: OrcCtor, ProjectReviewStore: ReviewStore, kanban, nerve } = modules;
  const options: typeof DEFAULT_OPTIONS = { ...DEFAULT_OPTIONS, ...opts };
  const state = {
    holdAcceptance: options.holdAcceptance,
    failOrcMode: options.failOrcMode,
    lastTurn: "none" as ScheduledProjectScript["lastTurn"],
    admittedRoot: undefined as number | undefined,
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
      for (const child of workersOfRoot()) kanban.kanbanComplete(child.id, null, "worker complete");
    },
    failWorkers: () => {
      for (const child of workersOfRoot()) kanban.kanbanFail(child.id, "worker failed");
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
  };

  const orc = new OrcCtor({
    ownerPeer: "test-fixture",
    startPort: async (context: OrcInvocationContextV1, goal: string): Promise<void> => {
      const projectId = context.projectCardId;
      state.admittedRoot = projectId;
      const store = new ReviewStore();
      const supervision = store.getSupervision(projectId);
      if (!supervision || supervision.state === "awaiting_contract") {
        if (state.failOrcMode) {
          state.lastTurn = "failed";
          return; // the Orc dies before producing the contract
        }
        const contract = buildContract(projectId, goal);
        store.insertContract(contract);
        store.initializeSupervision(projectId, contract.id);
        for (let i = 0; i < options.workerCount; i++) {
          const workerId = kanban.kanbanEnqueue(`fixture-worker-${i}`, "agent", undefined, {
            parent_id: projectId,
            type: "W",
            goal: `Work lane ${i}`,
            delivery: "silent",
          });
          if (workerId !== 0) kanban.kanbanRunning(workerId);
        }
        state.lastTurn = "authored";
        return;
      }
      state.lastTurn = "failed"; // unscripted state — never reached by Stage-1 cells
    },
  });

  return { fixture: script, orc };
}

function buildContract(projectCardId: number, goal: string): ProjectAcceptanceContractV1 {
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
