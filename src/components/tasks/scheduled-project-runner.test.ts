import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { createExecutionSupervisor } from "../execution-control.js";

let TEST_HOME: string;
let mod: typeof import("./scheduled-project-runner.js");
let kanban: typeof import("./kanban-board.js");
let reviewStoreMod: typeof import("../project-acceptance/project-review-store.js");
let reconciler: typeof import("../reconciler.js");
let stateStore: typeof import("./task-state-store.js");
let nerveBus: typeof import("../nerve.js")["nerve"];
let runStoreMod: typeof import("../orc-project/orc-project-run-store.js");

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `scheduled-project-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanban = await import("./kanban-board.js");
  reviewStoreMod = await import("../project-acceptance/project-review-store.js");
  reconciler = await import("../reconciler.js");
  stateStore = await import("./task-state-store.js");
  nerveBus = (await import("../nerve.js")).nerve;
  runStoreMod = await import("../orc-project/orc-project-run-store.js");
  mod = await import("./scheduled-project-runner.js");
});

afterEach(async () => {
  await activeHandle?.stop();
  activeHandle = null;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function makeControl(ref: string): import("../execution-control.js").ExecutionControl {
  return createExecutionSupervisor({ maxConcurrent: {} }).open({ executionRef: ref, type: "T" });
}

let activeHandle: import("../reconciler.js").ReconcilerHandle | null = null;

/** #1554: start a real generation over the tmpdir stores with a scripted coordinator. */
async function startGeneration(coordinator: unknown): Promise<void> {
  const { LifecycleWakeScheduler } = await import("../lifecycle-wake-scheduler.js");
  const { SpinWorkerAdapter } = await import("../spin-worker-adapter.js");
  const { ReconcileQuarantineStore } = await import("../reconcile-quarantine-store.js");
  await activeHandle?.stop();
  activeHandle = null;
  const scheduler = new LifecycleWakeScheduler();
  activeHandle = await reconciler.startReconciler({
    generationId: `runner-test-${Date.now()}`,
    coordinator: coordinator as never,
    wakeScheduler: scheduler,
    workerAdapter: new SpinWorkerAdapter(),
    piService: null,
    createPiAdapter: (() => ({ kind: "pi", capacity: async () => ({ available: 0, max: 0 }), start: async () => ({ kind: "start_failed", reason: "unavailable", retryable: false }), cancel: async () => ({ kind: "cancelled", attemptId: "" }), inspect: async () => ({ kind: "running", lifecycle: "running" }) })) as never,
    getQuarantineStore: () => new ReconcileQuarantineStore(),
    projectRunProgress: () => {},
  } as never);
  await scheduler.start();
}

/** #1628 review: authoring-budget reads for the reattach path. Defaults to the
 * zero-budget stub (claim always allowed); tests can inject the real store. */
type AuthoringBudgetStore = {
  countStartedAuthoringTurns: (cardId: number, generation: number) => number;
  countConsecutiveUnstartableAuthoringTurns: (cardId: number, generation: number) => number;
  lastAuthoringClaimAt: (cardId: number, generation: number) => string | null;
  lastAuthoringFailureCode: (cardId: number, generation: number) => string | null;
};
async function fakeCoordinator(storeFactory?: () => AuthoringBudgetStore): Promise<Array<{ projectCardId: number; goal: string; intentKind: "contract_authoring" | "project_execution" }>> {
  const claims: Array<{ projectCardId: number; goal: string; intentKind: "contract_authoring" | "project_execution" }> = [];
  await startGeneration({
    getStore: storeFactory ?? (() => ({ countStartedAuthoringTurns: () => 0, countConsecutiveUnstartableAuthoringTurns: () => 0, lastAuthoringClaimAt: () => null, lastAuthoringFailureCode: () => null })),
    bootRecovery: () => [] as number[],
    onOwnershipReleased: () => () => {},
    scheduleProjectExecution(projectCardId: number, goal: string) {
      claims.push({ projectCardId, goal, intentKind: "project_execution" });
      // a real claim is durable — the shared driver observes the live row
      try {
        return new runStoreMod.OrcProjectRunStore().claimIntent(
          { projectCardId, intentKind: "project_execution", goal, originKind: "local", cardSource: "task", sourcePeer: null },
          "test-peer",
          "test-instance",
        );
      } catch { /* best effort — the driver still observes the claim result */ }
      return { kind: "claimed", context: { runId: "or_test", projectCardId } };
    },
    scheduleContractAuthoring(projectCardId: number, goal?: string) {
      const persistedGoal = goal ?? "contract_authoring";
      claims.push({ projectCardId, goal: persistedGoal, intentKind: "contract_authoring" });
      try {
        return new runStoreMod.OrcProjectRunStore().claimIntent(
          { projectCardId, intentKind: "contract_authoring", goal: persistedGoal, originKind: "local", cardSource: "task", sourcePeer: null },
          "test-peer",
          "test-instance",
        );
      } catch {
        return { kind: "claimed", context: { runId: "or_authoring", projectCardId } };
      }
    },
  } as never);
  return claims;
}

function makeRequest(overrides: Record<string, unknown> = {}): ReturnType<typeof buildRequest> {
  return buildRequest(overrides);
}

function buildRequest(overrides: Record<string, unknown> = {}): {
  entryId: string;
  runId: string;
  title: string;
  goal: string;
  priority: "medium";
  maxAgents: number;
  deadlineAt: number;
  executionScope: { cwd: string; env: Record<string, string> };
  executionControl: import("../execution-control.js").ExecutionControl;
  delivery: "report";
  chatId: string;
  reportArtifactPath: string;
} {
  const ref = `spr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    entryId: "daily-ai",
    runId: "daily-ai_1",
    title: "Daily Ai",
    goal: "produce the daily briefing",
    priority: "medium",
    maxAgents: 4,
    deadlineAt: Date.now() + 60_000,
    executionScope: { cwd: join(TEST_HOME, "workspace", "daily-ai"), env: { WORKSPACE: join(TEST_HOME, "workspace", "daily-ai") } },
    executionControl: makeControl(ref),
    delivery: "report",
    chatId: "1",
    reportArtifactPath: join(TEST_HOME, "workspace", "daily-ai", "Daily-Briefing-{today}.md"),
    ...overrides,
  } as never;
}

const TASK_ENTRY = {
  id: "daily-ai",
  kind: "agent" as const,
  prompt: "Produce the daily briefing",
  agent: "task",
  interaction: { mode: "oneshot" as const },
  orchestration: { maxAgents: 4 },
  schedule: "* * * * *",
  enabled: true,
  priority: "medium" as const,
  delivery: "report" as const,
  report: {
    artifact: "/tmp/daily-ai-report.md",
    requiredSections: ["Summary"],
    minBytes: 100,
    requires: { files: [], executables: [], tools: [] },
  },
};

async function seedReservation(entryId = "daily-ai", runId = "daily-ai_1"): Promise<void> {
  // #1707: the reconciler's abandoned-occurrence guard looks up the owning
  // task definition before deciding whether an O card may be resumed. Keep
  // these reattach fixtures shaped like production state instead of relying
  // on a task_state row without its tasks.json catalog entry.
  mkdirSync(join(TEST_HOME, "tasks"), { recursive: true });
  writeFileSync(join(TEST_HOME, "tasks", "tasks.json"), JSON.stringify([TASK_ENTRY], null, 2));
  const now = Date.now();
  const result = stateStore.reserveRun(entryId, {
    runId,
    groupId: `${entryId}:group:${now}`,
    attempt: 1,
    trigger: "schedule",
    occurrenceAt: now,
    deadlineAt: now + 60_000,
  });
  if (!result.ok) throw new Error("reservation conflict");
}

describe("scheduled-project-runner #1516", () => {
  it("admits one root O card with the durable cap and resolves accepted synthesis", async () => {
    const claims = await fakeCoordinator();
    await seedReservation();
    const control = makeControl("spr-accept");
    const request = makeRequest({ executionControl: control });

    const pending = mod.scheduledProjectRunner(request);

    expect(claims).toHaveLength(1);
    expect(claims[0]!.intentKind).toBe("contract_authoring");
    expect(claims[0]!.goal).toContain("Agent budget: 4 total agents (1 Orc + up to 3");
    expect(claims[0]!.goal).toContain("sole writer");
    expect(claims[0]!.goal).toContain("Daily-Briefing");
    expect(claims[0]!.goal).toContain("[TASK]\nproduce the daily briefing");
    expect(claims[0]!.goal).toContain("a lane that fetches live web pages needs >= 300000 ms (max_duration_ms)");
    expect(claims[0]!.goal).toContain("Every declared criterion MUST have an evidence path - a verification command or a required artifact - or the contract is rejected.");
    const cards = kanban.kanbanList("*");
    expect(cards).toHaveLength(1);
    const root = cards[0]!;
    expect(root.type).toBe("O");
    expect(root.max_agents).toBe(4);
    expect(root.source).toBe("task");
    expect(root.source_id).toBe("daily-ai_1");
    expect(root.due_at).not.toBeNull();
    expect(Date.parse(root.due_at!)).toBeGreaterThan(Date.now());
    expect(control.cardId).toBe(root.id);
    expect(stateStore.readState("daily-ai")?.activeRun?.cardId).toBe(root.id);

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleAcceptance(root.id, "case-accept", { synthesis: "final synthesis text" }, "final synthesis text", undefined, "rd_test_accept");
    nerveBus.fire("card:done", root.id);

    const result = await pending;
    expect(result).toEqual(expect.objectContaining({ cardId: root.id, result: "final synthesis text" }));
  });

  it("rejects with the blocked reason when the project is blocked", async () => {
    await fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleBlocked(root.id, "case-blocked", { synthesis: "x" }, "blocker_class_xyz");
    nerveBus.fire("card:failed", root.id);

    await expect(pending).rejects.toThrow(/blocker_class_xyz/);
  });

  it("#1588: a lane completing past its hard deadline yields supervision/lane_late_completion with full lane facts", async () => {
    await fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    const workerId = kanban.kanbanEnqueue("Lane 3 - Web Verification", "agent", undefined, {
      parent_id: root.id,
      type: "W",
      goal: "Browse three web pages and record results",
      delivery: "silent",
    });
    const supStore = new (await import("../worker-supervision-store.js")).WorkerSupervisionStore();
    const contract: import("../worker-contract.js").WorkerAcceptanceContractV1 = {
      schema_version: 1,
      id: "c_late",
      digest: "dg_late",
      goal: "Browse three web pages and record results",
      criteria: [{ id: "c1", description: "Three web pages browsed and results recorded" }],
      expected_artifacts: [{ id: "a1", kind: "file", ref: "notes/web-results.md", required: true, criterion_ids: ["c1"] }],
      verification_commands: [],
      required_capabilities: [],
      limits: { max_duration_ms: 120000 },
      provenance: { root_card_id: root.id, card_id: workerId, authored_by: "orc", created_at: new Date().toISOString() },
    };
    supStore.insertContract(contract, workerId);
    supStore.insertAttempt({ id: "a_late", card_id: workerId, contract_id: contract.id, ordinal: 1, executor_kind: "agent", executor_id: "spin", status: "running", started_at: "2026-08-06T13:44:00.000Z" });
    supStore.lifecycleTransition("a_late", ["running"], "timed_out", {
      cancel_reason: "late_completion_timed_out: worker_completed",
      hard_deadline_at: "2026-08-06T13:46:38.195Z",
      settled_at: "2026-08-06T13:46:45.680Z",
    });

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleBlocked(root.id, "case-late", { synthesis: "x" }, "criteria failed");
    nerveBus.fire("card:failed", root.id);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.SupervisedProjectFailure);
    const failure = err as InstanceType<typeof mod.SupervisedProjectFailure>;
    expect(failure.diagnostic.category).toBe("supervision");
    expect(failure.diagnostic.code).toBe("lane_late_completion");
    const lane = failure.diagnostic.context!.lanes[0]!;
    expect(lane.cardId).toBe(workerId);
    expect(lane.contractId).toBe("c_late");
    expect(lane.attemptId).toBe("a_late");
    expect(lane.lifecycle).toBe("timed_out");
    expect(lane.cancelReason).toBe("late_completion_timed_out: worker_completed");
    expect(lane.hardDeadlineAt).toBe("2026-08-06T13:46:38.195Z");
    expect(lane.settledAt).toBe("2026-08-06T13:46:45.680Z");
    expect(lane.overrunMs).toBe(7485);
    expect(lane.bindingLimit).toEqual({ name: "max_duration_ms", value: 120000 });
    expect(lane.criteria).toEqual([{ id: "c1", status: "not_run" }]);
    expect(lane.missingEvidence).toEqual([]);
    expect(failure.factAt).toBeDefined();
  });

  it("#1588: an unevidenceable lane reports criterion_unevidenced before the lane outcome", async () => {
    await fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    const workerId = kanban.kanbanEnqueue("Lane 3 - Web Verification", "agent", undefined, {
      parent_id: root.id,
      type: "W",
      goal: "Browse three web pages and record results",
      delivery: "silent",
    });
    const supStore = new (await import("../worker-supervision-store.js")).WorkerSupervisionStore();
    const contract: import("../worker-contract.js").WorkerAcceptanceContractV1 = {
      schema_version: 1,
      id: "c_unev",
      digest: "dg_unev",
      goal: "Browse three web pages and record results",
      criteria: [{ id: "c1", description: "Three web pages browsed and results recorded" }],
      expected_artifacts: [],
      verification_commands: [],
      required_capabilities: [],
      limits: { max_duration_ms: 120000 },
      provenance: { root_card_id: root.id, card_id: workerId, authored_by: "orc", created_at: new Date().toISOString() },
    };
    supStore.insertContract(contract, workerId);
    supStore.insertAttempt({ id: "a_unev", card_id: workerId, contract_id: contract.id, ordinal: 1, executor_kind: "agent", executor_id: "spin", status: "running", started_at: "2026-08-06T13:44:00.000Z" });
    supStore.lifecycleTransition("a_unev", ["running"], "timed_out", {
      cancel_reason: "late_completion_timed_out: worker_completed",
      hard_deadline_at: "2026-08-06T13:46:38.195Z",
      settled_at: "2026-08-06T13:46:45.680Z",
    });

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleBlocked(root.id, "case-unev", { synthesis: "x" }, "criteria failed");
    nerveBus.fire("card:failed", root.id);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.SupervisedProjectFailure);
    const failure = err as InstanceType<typeof mod.SupervisedProjectFailure>;
    expect(failure.diagnostic.category).toBe("supervision");
    expect(failure.diagnostic.code).toBe("criterion_unevidenced");
    expect(failure.diagnostic.context!.lanes[0]!.missingEvidence).toContain("c1");
  });

  it("aborts the project and rejects when the scheduled deadline is already exceeded", async () => {
    await fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest({ deadlineAt: Date.now() - 1000 }));

    await expect(pending).rejects.toThrow(/deadline exceeded/);
    const root = kanban.kanbanList("*")[0]!;
    expect(root.status).toBe("failed");
  });

  it("aborts the project and rejects on execution-control cancellation", async () => {
    await fakeCoordinator();
    await seedReservation();
    const control = makeControl("spr-cancel");
    const pending = mod.scheduledProjectRunner(makeRequest({ executionControl: control }));
    const root = kanban.kanbanList("*")[0]!;

    control.signalCancel("deadline");
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(kanban.kanbanGetCard(root.id)?.status).toBe("failed");
    expect(new reviewStoreMod.ProjectReviewStore().getSupervision(root.id)?.state).toBe("blocked");
    expect(() => new reviewStoreMod.ProjectReviewStore().settleAcceptance(
      root.id,
      "late-case",
      { synthesis: "late" },
      "late",
    )).toThrow(/already terminal/);
  });

  it("#1600 reads terminal project evidence before honoring a deadline cancellation", async () => {
    vi.useFakeTimers();
    try {
      await fakeCoordinator();
      await seedReservation();
      const control = makeControl("spr-pre-kill-terminal");
      const pending = mod.scheduledProjectRunner(makeRequest({ executionControl: control }));
      const root = kanban.kanbanList("*")[0]!;
      const factAt = Date.now() - 1000;

      // Model a durable project terminal fact that was written before the
      // inactivity kill, but whose event is observed only by the recheck.
      kanban._kanbanExecForTest(
        "UPDATE kanban_board SET status = 'done', result_summary = ?, updated_at = ? WHERE id = ?",
        ["finished before kill", new Date(factAt).toISOString(), root.id],
      );
      stateStore.requestRunTerminal("daily-ai", "daily-ai_1", {
        kind: "deadline_exceeded", requestedAt: Date.now(), reason: "no progress for 15min",
      });
      control.signalCancel("deadline");

      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toEqual(expect.objectContaining({
        cardId: root.id,
        result: "finished before kill",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("reattaches to the persisted card on duplicate admission and never creates a second project", async () => {
    const claims = await fakeCoordinator();
    await seedReservation();
    const request = makeRequest();

    const p1 = mod.scheduledProjectRunner(request);
    const p2 = mod.scheduledProjectRunner(request);

    const roots = kanban.kanbanList("*").filter(c => c.type === "O");
    expect(roots).toHaveLength(1);
    expect(claims.map(c => c.projectCardId)).toEqual([roots[0]!.id, roots[0]!.id]);

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleAcceptance(roots[0]!.id, "case-dup", { synthesis: "dup synthesis" }, "dup synthesis", undefined, "rd_test_dup");
    nerveBus.fire("card:done", roots[0]!.id);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.cardId).toBe(roots[0]!.id);
    expect(r2.cardId).toBe(roots[0]!.id);
  });

  it("refuses admission when a different run owns the active reservation", async () => {
    await fakeCoordinator();
    await seedReservation("daily-ai", "other-run");
    await expect(mod.scheduledProjectRunner(makeRequest({ runId: "daily-ai_1" }))).rejects.toThrow(/admission conflict/);
    expect(kanban.kanbanList("*")).toHaveLength(0);
  });

  it("#1588: the Orc goal carries the machine-derived lane duration budget when set", async () => {
    const claims = await fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest({ laneDurationMs: 600000 } as never));
    expect(claims).toHaveLength(1);
    expect(claims[0]!.goal).toContain("every lane carries a hard max_duration_ms of 600000 ms");
    const root = kanban.kanbanList("*")[0]!;
    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleAcceptance(root.id, "case-budget", { synthesis: "ok" }, "ok", undefined, "rd_budget");
    nerveBus.fire("card:done", root.id);
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root.id }));
  });

  it("refuses a persisted card whose durable source identity belongs to another run", async () => {
    await fakeCoordinator();
    await seedReservation();
    const root = kanban.kanbanEnqueue("Daily Ai", "task", "other-run", { type: "O", maxAgents: 4 });
    stateStore.updateActiveRun("daily-ai", "daily-ai_1", { cardId: root });

    await expect(mod.scheduledProjectRunner(makeRequest())).rejects.toThrow(/identity conflict/);
    expect(kanban.kanbanList("*")).toHaveLength(1);
  });

  it("resolves immediately when the persisted card is already terminal", async () => {
    await fakeCoordinator();
    await seedReservation();
    const store = new reviewStoreMod.ProjectReviewStore();
    const root = kanban.kanbanEnqueue("Daily Ai", "task", "daily-ai_1", { type: "O", maxAgents: 4 });
    // #1590: settleAcceptance is a running→done transition — dispatch first.
    kanban.kanbanRunning(root);
    store.ensureAwaitingContract(root);
    store.settleAcceptance(root, "case-reattach", { synthesis: "already accepted" }, "already accepted", undefined, "rd_test_reattach");
    stateStore.updateActiveRun("daily-ai", "daily-ai_1", { cardId: root });

    const result = await mod.scheduledProjectRunner(makeRequest());
    expect(result).toEqual(expect.objectContaining({ cardId: root, result: "already accepted" }));
    expect(kanban.kanbanGetCard(root)?.status).toBe("done");
  });

  it("#1605: an accepted root delivers the RENDERED synthesis (card result with Known gaps), not the authored decision text", async () => {
    await fakeCoordinator();
    await seedReservation();
    const store = new reviewStoreMod.ProjectReviewStore();
    const root = kanban.kanbanEnqueue("Daily Ai", "task", "daily-ai_1", { type: "O", maxAgents: 4 });
    kanban.kanbanRunning(root);
    store.ensureAwaitingContract(root);
    // settleAcceptance writes the rendered synthesis (with disclosure) to the
    // card result; the durable decision keeps the authored text unchanged.
    store.settleAcceptance(
      root,
      "case-render",
      { action: "accept", synthesis: "Briefing delivered." },
      "Briefing delivered.\n\nKnown gaps:\n- lane3-web: unsatisfied — web lane failed",
      undefined,
      "rd_test_render",
    );
    stateStore.updateActiveRun("daily-ai", "daily-ai_1", { cardId: root });

    const result = await mod.scheduledProjectRunner(makeRequest());
    expect(result.result).toContain("Known gaps:");
    expect(result.result).toContain("lane3-web: unsatisfied");
    // the authored decision text alone would not contain the disclosure
    expect(result.result).not.toBe("Briefing delivered.");
  });

  it("#1604: durable uncovered ids yield supervision/contract_uncovered naming them", async () => {
    await fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleBlocked(root.id, "case-cov", { synthesis: "x" }, "blocked");
    store.db.prepare(`UPDATE project_supervision SET coverage_uncovered_ids = ? WHERE project_card_id = ?`)
      .run(JSON.stringify(["c4", "c5"]), root.id);
    nerveBus.fire("card:failed", root.id);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.SupervisedProjectFailure);
    const failure = err as InstanceType<typeof mod.SupervisedProjectFailure>;
    expect(failure.diagnostic.category).toBe("supervision");
    expect(failure.diagnostic.code).toBe("contract_uncovered");
    expect(failure.diagnostic.message).toContain("c4");
    expect(failure.diagnostic.message).toContain("c5");
  });

  it("#1604: NULL coverage ids surface the lane code, not contract_uncovered (deadline-misdiagnosis fix)", async () => {
    await fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    const workerId = kanban.kanbanEnqueue("Lane 3 - Web Verification", "agent", undefined, {
      parent_id: root.id,
      type: "W",
      goal: "Browse three web pages and record results",
      delivery: "silent",
    });
    const supStore = new (await import("../worker-supervision-store.js")).WorkerSupervisionStore();
    const contract: import("../worker-contract.js").WorkerAcceptanceContractV1 = {
      schema_version: 1,
      id: "c_null",
      digest: "dg_null",
      goal: "Browse three web pages and record results",
      criteria: [{ id: "c1", description: "Three web pages browsed and results recorded" }],
      expected_artifacts: [{ id: "a1", kind: "file", ref: "notes/web-results.md", required: true, criterion_ids: ["c1"] }],
      verification_commands: [],
      required_capabilities: [],
      limits: { max_duration_ms: 120000 },
      provenance: { root_card_id: root.id, card_id: workerId, authored_by: "orc", created_at: new Date().toISOString() },
    };
    supStore.insertContract(contract, workerId);
    supStore.insertAttempt({ id: "a_null", card_id: workerId, contract_id: contract.id, ordinal: 1, executor_kind: "agent", executor_id: "spin", status: "running", started_at: "2026-08-06T13:44:00.000Z" });
    supStore.lifecycleTransition("a_null", ["running"], "timed_out", {
      cancel_reason: "late_completion_timed_out: worker_completed",
      hard_deadline_at: "2026-08-06T13:46:38.195Z",
      settled_at: "2026-08-06T13:46:45.680Z",
    });

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleBlocked(root.id, "case-null", { synthesis: "x" }, "criteria failed");
    // coverage_uncovered_ids stays NULL — never evaluated before death
    nerveBus.fire("card:failed", root.id);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.SupervisedProjectFailure);
    const failure = err as InstanceType<typeof mod.SupervisedProjectFailure>;
    expect(failure.diagnostic.category).toBe("supervision");
    expect(failure.diagnostic.code).toBe("lane_late_completion");
  });

  it("#1604: empty coverage ids with a failed lane yield the lane code", async () => {
    await fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    const workerId = kanban.kanbanEnqueue("Lane 3 - Web Verification", "agent", undefined, {
      parent_id: root.id,
      type: "W",
      goal: "Browse three web pages and record results",
      delivery: "silent",
    });
    const supStore = new (await import("../worker-supervision-store.js")).WorkerSupervisionStore();
    const contract: import("../worker-contract.js").WorkerAcceptanceContractV1 = {
      schema_version: 1,
      id: "c_empty",
      digest: "dg_empty",
      goal: "Browse three web pages and record results",
      criteria: [{ id: "c1", description: "Three web pages browsed and results recorded" }],
      expected_artifacts: [{ id: "a1", kind: "file", ref: "notes/web-results.md", required: true, criterion_ids: ["c1"] }],
      verification_commands: [],
      required_capabilities: [],
      limits: { max_duration_ms: 120000 },
      provenance: { root_card_id: root.id, card_id: workerId, authored_by: "orc", created_at: new Date().toISOString() },
    };
    supStore.insertContract(contract, workerId);
    supStore.insertAttempt({ id: "a_empty", card_id: workerId, contract_id: contract.id, ordinal: 1, executor_kind: "agent", executor_id: "spin", status: "running", started_at: "2026-08-06T13:44:00.000Z" });
    supStore.lifecycleTransition("a_empty", ["running"], "timed_out", {
      cancel_reason: "late_completion_timed_out: worker_completed",
      hard_deadline_at: "2026-08-06T13:46:38.195Z",
      settled_at: "2026-08-06T13:46:45.680Z",
    });

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleBlocked(root.id, "case-empty", { synthesis: "x" }, "criteria failed");
    store.db.prepare(`UPDATE project_supervision SET coverage_uncovered_ids = '[]' WHERE project_card_id = ?`).run(root.id);
    nerveBus.fire("card:failed", root.id);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.SupervisedProjectFailure);
    const failure = err as InstanceType<typeof mod.SupervisedProjectFailure>;
    expect(failure.diagnostic.category).toBe("supervision");
    expect(failure.diagnostic.code).toBe("lane_late_completion");
  });

  it("#1604: coverage_undeterminable in blocked_reason surfaces as project_blocked, never masked by lane codes", async () => {
    await fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    const workerId = kanban.kanbanEnqueue("Lane 3 - Web Verification", "agent", undefined, {
      parent_id: root.id,
      type: "W",
      goal: "Browse three web pages and record results",
      delivery: "silent",
    });
    const supStore = new (await import("../worker-supervision-store.js")).WorkerSupervisionStore();
    const contract: import("../worker-contract.js").WorkerAcceptanceContractV1 = {
      schema_version: 1,
      id: "c_undet",
      digest: "dg_undet",
      goal: "Browse three web pages and record results",
      criteria: [{ id: "c1", description: "Three web pages browsed and results recorded" }],
      expected_artifacts: [],
      verification_commands: [],
      required_capabilities: [],
      limits: { max_duration_ms: 120000 },
      provenance: { root_card_id: root.id, card_id: workerId, authored_by: "orc", created_at: new Date().toISOString() },
    };
    supStore.insertContract(contract, workerId);
    supStore.insertAttempt({ id: "a_undet", card_id: workerId, contract_id: contract.id, ordinal: 1, executor_kind: "agent", executor_id: "spin", status: "running", started_at: "2026-08-06T13:44:00.000Z" });
    supStore.lifecycleTransition("a_undet", ["running"], "timed_out", {
      cancel_reason: "late_completion_timed_out: worker_completed",
      hard_deadline_at: "2026-08-06T13:46:38.195Z",
      settled_at: "2026-08-06T13:46:45.680Z",
    });

    const store = new reviewStoreMod.ProjectReviewStore();
    // The gate blocks with an undeterminable reason; a failed lane exists but
    // must NOT override the undeterminable fact.
    store.settleBlocked(root.id, "case-undet", { synthesis: "x" }, "coverage_undeterminable: root contract for project #1 is missing or has no criteria array");
    nerveBus.fire("card:failed", root.id);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.SupervisedProjectFailure);
    const failure = err as InstanceType<typeof mod.SupervisedProjectFailure>;
    expect(failure.diagnostic.category).toBe("supervision");
    expect(failure.diagnostic.code).toBe("project_blocked");
    expect(failure.diagnostic.message).toContain("coverage_undeterminable");
  });

  it("#1605: an accepted root with a failed lane returns the accepted synthesis", async () => {
    await fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    // A failed lane with a durable attempt
    const workerId = kanban.kanbanEnqueue("Lane 2 - Failed", "agent", undefined, {
      parent_id: root.id,
      type: "W",
      delivery: "silent",
    });
    const supStore = new (await import("../worker-supervision-store.js")).WorkerSupervisionStore();
    const contract: import("../worker-contract.js").WorkerAcceptanceContractV1 = {
      schema_version: 1,
      id: "c_accepted_fail",
      digest: "dg_accepted_fail",
      goal: "Lane 2",
      criteria: [{ id: "c1", description: "Lane 2 criterion" }],
      expected_artifacts: [],
      verification_commands: [],
      required_capabilities: [],
      limits: {},
      provenance: { root_card_id: root.id, card_id: workerId, authored_by: "orc", created_at: new Date().toISOString() },
    };
    supStore.insertContract(contract, workerId);
    supStore.insertAttempt({ id: "a_failed_lane", card_id: workerId, contract_id: contract.id, ordinal: 1, executor_kind: "agent", executor_id: "spin", status: "failed", started_at: new Date().toISOString() });

    // Orc accepts despite the failed lane
    const store = new reviewStoreMod.ProjectReviewStore();
    kanban.kanbanRunning(root.id);
    store.ensureAwaitingContract(root.id);
    store.settleAcceptance(root.id, "case-accepted-fail", { action: "accept", synthesis: "accepted despite lane loss" }, "accepted despite lane loss", undefined, "rd_accepted_fail");
    nerveBus.fire("card:done", root.id);

    const result = await pending;
    expect(result.result).toContain("accepted despite lane loss");
  });

  it("#1605: an Orc-blocked decision with persisted gaps surfaces project_blocked with the Orc blocker, not contract_uncovered", async () => {
    await fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    // A failed lane exists so a naive lane code would win — the Orc decision must not.
    const workerId = kanban.kanbanEnqueue("Lane 1 - Failed", "agent", undefined, {
      parent_id: root.id,
      type: "W",
      delivery: "silent",
    });
    const supStore = new (await import("../worker-supervision-store.js")).WorkerSupervisionStore();
    const contract: import("../worker-contract.js").WorkerAcceptanceContractV1 = {
      schema_version: 1,
      id: "c_orc_block",
      digest: "dg_orc_block",
      goal: "Lane 1",
      criteria: [{ id: "c1", description: "Lane 1 criterion" }],
      expected_artifacts: [],
      verification_commands: [],
      required_capabilities: [],
      limits: {},
      provenance: { root_card_id: root.id, card_id: workerId, authored_by: "orc", created_at: new Date().toISOString() },
    };
    supStore.insertContract(contract, workerId);
    supStore.insertAttempt({ id: "a_orc_block", card_id: workerId, contract_id: contract.id, ordinal: 1, executor_kind: "agent", executor_id: "spin", status: "failed", started_at: new Date().toISOString() });

    const store = new reviewStoreMod.ProjectReviewStore();
    // Orc-blocked decision (action: blocked) while a normal review gap is persisted
    store.settleBlocked(root.id, "case-orc-block", { action: "blocked", blocker: { blocker_class: "insufficient_evidence" }, synthesis: "cannot deliver" }, "insufficient_evidence");
    store.db.prepare(`UPDATE project_supervision SET coverage_uncovered_ids = ? WHERE project_card_id = ?`)
      .run(JSON.stringify(["lane2"]), root.id);
    nerveBus.fire("card:failed", root.id);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.SupervisedProjectFailure);
    const failure = err as InstanceType<typeof mod.SupervisedProjectFailure>;
    expect(failure.diagnostic.code).toBe("project_blocked");
    expect(failure.diagnostic.message).toContain("insufficient_evidence");
    expect(failure.diagnostic.code).not.toBe("contract_uncovered");
    expect(failure.diagnostic.code).not.toBe("lane_failed");
  });

  it("#1605: a pre-review structural block without an Orc decision keeps the lane/definition diagnostics", async () => {
    await fakeCoordinator();
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleBlocked(root.id, "case-structural", { synthesis: "x" }, "criteria failed");
    store.db.prepare(`UPDATE project_supervision SET coverage_uncovered_ids = ? WHERE project_card_id = ?`)
      .run(JSON.stringify(["lane2"]), root.id);
    nerveBus.fire("card:failed", root.id);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.SupervisedProjectFailure);
    const failure = err as InstanceType<typeof mod.SupervisedProjectFailure>;
    // no Orc decision with action=blocked → legacy coverage/lane selection still applies
    expect(failure.diagnostic.code).toBe("contract_uncovered");
  });
});

describe("scheduled-project-runner #1546 reattach routing", () => {
  // #1554: seed FIRST, start the generation after — the boot scan must not
  // observe the fixture (the runner's wake owns the claim timing).
  async function seedExecutingReattach(overrides: Record<string, unknown> = {}): Promise<{ root: number; store: InstanceType<typeof reviewStoreMod.ProjectReviewStore>; claims: Array<{ projectCardId: number; goal: string }> }> {
    const { root, store } = await seedReattach({ state: "executing", ...overrides });
    const claims = await fakeCoordinator();
    return { root, store, claims };
  }

  async function seedReattach(opts: { state?: string; cardStatus?: string; retryMarker?: string | null }): Promise<{ root: number; store: InstanceType<typeof reviewStoreMod.ProjectReviewStore> }> {
    const root = kanban.kanbanEnqueue("Daily Ai", "task", "daily-ai_1", { type: "O", maxAgents: 4 });
    const store = new reviewStoreMod.ProjectReviewStore();
    if (opts.state) {
      store.ensureAwaitingContract(root);
      if (opts.state !== "awaiting_contract") {
        // a valid non-awaiting supervision carries its root contract
        store.insertContract({
          schema_version: 1,
          id: `ct_${root}`,
          digest: `dg_${root}`,
          project_card_id: root,
          goal: "daily briefing",
          criteria: [{ id: "c1", description: "goal met", required: true, evidence_expectation: "synthesis" }],
          required_outputs: [],
          constraints: [],
          limits: {},
          provenance: { requested_by: "scheduler", authored_by: "orc", created_at: new Date().toISOString() },
        } as never);
        store.setState(root, opts.state as never);
      }
    }
    stateStore.updateActiveRun("daily-ai", "daily-ai_1", { cardId: root });
    if (opts.cardStatus === "queued") {
      const marker = opts.retryMarker ?? new Date(Date.now() + 60_000).toISOString();
      kanban._kanbanExecForTest(`UPDATE kanban_board SET status = 'queued', next_retry_at = ? WHERE id = ?`, [marker, root]);
    } else {
      kanban.kanbanRunning(root);
    }
    return { root, store };
  }

  it("keeps the synchronous goal-bearing claim on an awaiting_contract reattach", async () => {
    await seedReservation();
    const { root } = await seedReattach({ state: "awaiting_contract" });
    const claims = await fakeCoordinator();
    const pending = mod.scheduledProjectRunner(makeRequest());

    // the runner's synchronous goal-bearing claim is never dropped behind the
    // driver's generic authoring claim
    expect(claims.some(c => c.projectCardId === root && c.goal.includes("Agent budget"))).toBe(true);
    expect(kanban.kanbanGetCard(root)?.status).toBe("running");

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleAcceptance(root, "case-a", { synthesis: "ok" }, "ok", undefined, "rd_a");
    nerveBus.fire("card:done", root);
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root }));
  });

  it("#1656 binds the canonical workspace before the first Orc claim", async () => {
    await seedReservation();
    const claims = await fakeCoordinator();
    const pending = mod.scheduledProjectRunner(makeRequest());

    expect(claims).toHaveLength(1);
    const store = new reviewStoreMod.ProjectReviewStore();
    const scope = store.getWorkspaceScope(claims[0]!.projectCardId);
    expect(scope?.cwd).toBe(join(TEST_HOME, "workspace", "daily-ai"));
    expect(scope?.env).toEqual({ WORKSPACE: join(TEST_HOME, "workspace", "daily-ai") });
    expect(store.getSupervision(claims[0]!.projectCardId)!.workspace_cwd).toBe(join(TEST_HOME, "workspace", "daily-ai"));

    store.settleAcceptance(claims[0]!.projectCardId, "case-b", { synthesis: "ok" }, "ok", undefined, "rd_b");
    nerveBus.fire("card:done", claims[0]!.projectCardId);
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: claims[0]!.projectCardId }));
  });

  it("#1656 a reattach with a different cwd fails closed and never rebinds", async () => {
    await seedReservation();
    const { root } = await seedReattach({ state: "executing" });
    await fakeCoordinator();
    const store = new reviewStoreMod.ProjectReviewStore();
    const first = join(TEST_HOME, "workspace", "daily-ai");
    const second = join(TEST_HOME, "workspace", "other");

    // first admission binds the canonical workspace
    const req1 = makeRequest();
    const pending1 = mod.scheduledProjectRunner(req1);
    expect(store.getWorkspaceScope(root)?.cwd).toBe(first);

    // a second admission with a different cwd is a mismatch — never a rebind
    const req2 = makeRequest({ executionScope: { cwd: second, env: { WORKSPACE: second } } });
    await expect(mod.scheduledProjectRunner(req2)).rejects.toThrow(/workspace mismatch/);
    expect(store.getWorkspaceScope(root)?.cwd).toBe(first);

    store.settleAcceptance(root, "case-c", { synthesis: "ok" }, "ok", undefined, "rd_c");
    nerveBus.fire("card:done", root);
    await expect(pending1).resolves.toEqual(expect.objectContaining({ cardId: root }));
  });

  it("reattach in a non-terminal non-awaiting state never authors and wakes the shared driver", async () => {
    await seedReservation();
    const { root, store, claims } = await seedExecutingReattach();
    const pending = mod.scheduledProjectRunner(makeRequest());

    // #1554: the boot scan owns the continuation claim (executing + no
    // children + no live Orc row); the runner itself never authors. The
    // admission wake adds no second claim.
    expect(claims).toHaveLength(1);
    await new Promise(r => setTimeout(r, 20));
    expect(claims).toHaveLength(1);
    expect(claims[0]!.projectCardId).toBe(root);
    expect(store.getSupervision(root)?.state).toBe("executing");

    store.settleAcceptance(root, "case-e", { synthesis: "executing ok" }, "executing ok", undefined, "rd_e");
    nerveBus.fire("card:done", root);
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root }));
  });

  it("terminal reattach reads terminal evidence without supervision insertion or a claim", async () => {
    await seedReservation();
    const root = kanban.kanbanEnqueue("Daily Ai", "task", "daily-ai_1", { type: "O", maxAgents: 4 });
    // #1590: kanbanComplete is running→done — dispatch first.
    kanban.kanbanRunning(root);
    kanban.kanbanComplete(root, null, "already completed");
    stateStore.updateActiveRun("daily-ai", "daily-ai_1", { cardId: root });
    const claims = await fakeCoordinator();

    const result = await mod.scheduledProjectRunner(makeRequest());

    expect(result).toEqual(expect.objectContaining({ cardId: root, result: "already completed" }));
    expect(new reviewStoreMod.ProjectReviewStore().getSupervision(root)).toBeUndefined();
    expect(claims).toHaveLength(0);
  });

  it("a reattached due queued retry is promoted only by the driver, never directly", async () => {
    await seedReservation();
    const { root, store } = await seedReattach({
      state: "executing",
      cardStatus: "queued",
      retryMarker: new Date(Date.now() - 1000).toISOString(),
    });
    const claims = await fakeCoordinator();
    const pending = mod.scheduledProjectRunner(makeRequest());

    // #1554: the boot scan claims the stranded due root exactly once
    // (claim-before-promotion), and the admission wake adds no second claim.
    await new Promise(r => setTimeout(r, 20));
    expect(claims).toHaveLength(1);
    await new Promise(r => setTimeout(r, 20));
    expect(claims).toHaveLength(1);
    expect(kanban.kanbanGetCard(root)?.status).toBe("running");
    expect(kanban.kanbanGetCard(root)?.next_retry_at).toBeNull();

    store.settleAcceptance(root, "case-q", { synthesis: "queued ok" }, "queued ok", undefined, "rd_q");
    nerveBus.fire("card:done", root);
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root }));
  });

  it("a reattached future queued retry stays queued and keeps its marker", async () => {
    await seedReservation();
    const { root } = await seedReattach({
      state: "executing",
      cardStatus: "queued",
      retryMarker: new Date(Date.now() + 60_000).toISOString(),
    });
    const claims = await fakeCoordinator();
    const control = makeControl("spr-future");
    const pending = mod.scheduledProjectRunner(makeRequest({ executionControl: control }));
    await new Promise(r => setTimeout(r, 20));

    expect(claims).toHaveLength(0);
    const card = kanban.kanbanGetCard(root)!;
    expect(card.status).toBe("queued");
    expect(card.next_retry_at).not.toBeNull();

    control.signalCancel("operator");
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it("#1628 review: reattach with a spent authoring budget never claims another turn", async () => {
    await seedReservation();
    const claims = await fakeCoordinator(() => new runStoreMod.OrcProjectRunStore() as never);
    // A queued card with a FUTURE retry marker is invisible to every driver
    // path (the boot scan skips non-stranded queued roots, the kanban-retry
    // due source only fires when due, deriveAction no-ops queued+future, and
    // reconcileChildCard returns without a contract): the runner's reattach
    // is the only actor that can claim here, so any fourth turn is its doing.
    const { root } = await seedReattach({
      state: "awaiting_contract",
      cardStatus: "queued",
      retryMarker: new Date(Date.now() + 60_000).toISOString(),
    });
    const generation = new reviewStoreMod.ProjectReviewStore().getSupervision(root)!.generation;
    const old = new Date(Date.now() - 600_000).toISOString();
    const rs = new runStoreMod.OrcProjectRunStore();
    for (let i = 0; i < 3; i++) {
      rs.db.prepare(`
        INSERT INTO orc_project_runs
          (id, intent_key, intent_kind, intent_ref, goal, project_card_id,
           project_generation, ownership_generation, owner_peer, owner_instance_id,
           origin_kind, origin_peer, state, outcome, failure_code, created_at, started_at, released_at, updated_at)
        VALUES (?, ?, 'contract_authoring', NULL, 'seeded goal', ?, ?, ?, 'kp', 'inst-test', 'local', NULL, 'released', 'failed', NULL, ?, ?, ?, ?)
      `).run(`or_spent_${root}_${i}`, `contract:${root}:${generation}`, root, generation, 100 + i, old, old, old, old);
    }
    const control = makeControl("spr-spent-budget");
    const pending = mod.scheduledProjectRunner(makeRequest({ executionControl: control }));
    await new Promise(r => setTimeout(r, 150));

    // Pre-fix the runner claimed a fourth turn here with the machine-derived
    // goal. Post-fix it defers to the driver, which no-ops on the not-due
    // card — no goal-bearing claim, no fourth run row, marker untouched.
    expect(claims.filter(c => c.intentKind === "contract_authoring" && String(c.goal).includes("Agent budget"))).toHaveLength(0);
    expect(new runStoreMod.OrcProjectRunStore().getRunsForProject(root)).toHaveLength(3);
    const card = kanban.kanbanGetCard(root)!;
    expect(card.status).toBe("queued");
    expect(card.next_retry_at).not.toBeNull();

    control.signalCancel("operator");
    await expect(pending).rejects.toThrow(/cancelled/);
  });
});
