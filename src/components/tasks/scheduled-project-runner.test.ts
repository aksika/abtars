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
let stateStore: typeof import("./task-state-store.js");
let nerveBus: typeof import("../nerve.js")["nerve"];

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `scheduled-project-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanban = await import("./kanban-board.js");
  reviewStoreMod = await import("../project-acceptance/project-review-store.js");
  stateStore = await import("./task-state-store.js");
  nerveBus = (await import("../nerve.js")).nerve;
  mod = await import("./scheduled-project-runner.js");
});

afterEach(async () => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function makeControl(ref: string): import("../execution-control.js").ExecutionControl {
  return createExecutionSupervisor({ maxConcurrent: {} }).open({ executionRef: ref, type: "T" });
}

/** #1792: drive the supervised lifecycle through the workflow runner. */
async function workflowTools() {
  const { WorkflowRunner } = await import("../orc-project/orc-workflow-runner.js");
  const { WorkflowStore } = await import("../orc-project/orc-workflow-store.js");
  const store = new WorkflowStore();
  return { runner: new WorkflowRunner(store, ["general", "research", "write"]), store };
}

function simplePlan() {
  return {
    requiredOutputs: ["report"],
    nodes: [
      { label: "a", kind: "work" as const, instructions: "research", capability: "research", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] as string[] },
      { label: "s", kind: "synthesis" as const, instructions: "draft", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["a"] },
    ],
  };
}

/** Complete every node successfully (review-free plans settle synchronously). */
async function succeedRun(
  runner: import("../orc-project/orc-workflow-runner.js").WorkflowRunner,
  runId: string,
  proposal: ReturnType<typeof simplePlan>,
): Promise<string[]> {
  const acc = runner.acceptPlan(runId, proposal as never);
  for (const nodeId of acc.nodeIds) {
    runner.attemptSucceeded(runId, nodeId, `att-${nodeId}`, "{}");
  }
  return acc.nodeIds as string[];
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
    await seedReservation();
    const control = makeControl("spr-accept");
    const request = makeRequest({ executionControl: control });

    const pending = mod.scheduledProjectRunner(request);

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

    // The card carries the raw task goal for the planner (no model-turn prompt).
    expect(root.goal).toContain("produce the daily briefing");

    // Drive the supervised lifecycle through the runner to reviewed success.
    const { runner, store } = await workflowTools();
    const run = store.findLatestRunByCard(root.id)!;
    expect(run.rootKind).toBe("scheduled");
    await succeedRun(runner, run.runId, simplePlan());

    const result = await pending;
    expect(result).toEqual(expect.objectContaining({ cardId: root.id }));
    expect(result.result).toContain("succeeded");
  });

  it("rejects with the blocked reason when the project is blocked", async () => {
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());
    const root = kanban.kanbanList("*")[0]!;

    // Fail the run through the runner: the waiter surfaces the run reason.
    const { runner, store } = await workflowTools();
    const run = store.findLatestRunByCard(root.id)!;
    const acc = runner.acceptPlan(run.runId, simplePlan());
    runner.attemptFailed(run.runId, acc.nodeIds[0] as string, "att-x", "blocker_class_xyz", false);

    await expect(pending).rejects.toThrow(/blocker_class_xyz/);
  });

  it("#1588: a lane completing past its hard deadline yields supervision/lane_late_completion with full lane facts", async () => {
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
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest({ deadlineAt: Date.now() - 1000 }));

    await expect(pending).rejects.toThrow(/deadline exceeded/);
    const root = kanban.kanbanList("*")[0]!;
    expect(root.status).toBe("failed");
  });

  it("aborts the project and rejects on execution-control cancellation", async () => {
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
    await seedReservation();
    const request = makeRequest();

    const p1 = mod.scheduledProjectRunner(request);
    const p2 = mod.scheduledProjectRunner(request);

    const roots = kanban.kanbanList("*").filter(c => c.type === "O");
    expect(roots).toHaveLength(1);

    // Both waiters resolve from the same runner terminal (driven once).
    const { runner, store } = await workflowTools();
    const run = store.findLatestRunByCard(roots[0]!.id)!;
    await succeedRun(runner, run.runId, simplePlan());

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.cardId).toBe(roots[0]!.id);
    expect(r2.cardId).toBe(roots[0]!.id);
    // Exactly one workflow run backs the shared card.
    const runs = store.db.prepare(`SELECT COUNT(*) as cnt FROM workflow_runs WHERE root_card_id = ?`).get(roots[0]!.id) as { cnt: number };
    expect(Number(runs.cnt)).toBe(1);
  });

  it("refuses admission when a different run owns the active reservation", async () => {
    await seedReservation("daily-ai", "other-run");
    await expect(mod.scheduledProjectRunner(makeRequest({ runId: "daily-ai_1" }))).rejects.toThrow(/admission conflict/);
    expect(kanban.kanbanList("*")).toHaveLength(0);
  });

  it("the card carries the raw task goal for the planner (no model-turn prompt)", async () => {
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest({ laneDurationMs: 600000 } as never));
    const root = kanban.kanbanList("*")[0]!;
    // Lane budgets now travel as task configuration, not prompt text: the
    // planner reads structured capabilities, not prose instructions.
    expect(root.goal).toContain("produce the daily briefing");
    const { runner, store } = await workflowTools();
    const run = store.findLatestRunByCard(root.id)!;
    await succeedRun(runner, run.runId, simplePlan());
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root.id }));
  });

  it("refuses a persisted card whose durable source identity belongs to another run", async () => {
    await seedReservation();
    const root = kanban.kanbanEnqueue("Daily Ai", "task", "other-run", { type: "O", maxAgents: 4 });
    stateStore.updateActiveRun("daily-ai", "daily-ai_1", { cardId: root });

    await expect(mod.scheduledProjectRunner(makeRequest())).rejects.toThrow(/identity conflict/);
    expect(kanban.kanbanList("*")).toHaveLength(1);
  });

  it("resolves immediately when the persisted card is already terminal", async () => {
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

  // #1605 rendered-synthesis "Known gaps" disclosure retired with the review
  // decision table (no authored decisions in runner flows; partial-result
  // disclosure lives in the run failure reason instead).

  // #1604 coverage gate retired with the reconciler coverage check (no coverage
  // rounds, signatures, or uncovered-ids in runner flows; acceptance coverage
  // is validated at plan admission). The lane-code fallback it shared stays
  // covered by the NULL/empty/late/unevidenced tests below.

  it("#1604: NULL coverage ids surface the lane code, not contract_uncovered (deadline-misdiagnosis fix)", async () => {
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

  // coverage_undeterminable retired with the coverage gate (same reason).

  // #1605 rendered-synthesis disclosure retired with the review decision table:
  // runner terminal evidence is the card result_summary written by projections
  // (covered by the admission test above), not an authored decision document.

  it("#1605: an accepted root with a failed lane returns the accepted synthesis", async () => {
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

  it("#1605: a pre-review structural block without an Orc decision keeps the lane/definition diagnostics", async () => {
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
      id: "c_struct",
      digest: "dg_struct",
      goal: "Browse three web pages and record results",
      criteria: [{ id: "c1", description: "Three web pages browsed and results recorded" }],
      expected_artifacts: [],
      verification_commands: [],
      required_capabilities: [],
      limits: { max_duration_ms: 120000 },
      provenance: { root_card_id: root.id, card_id: workerId, authored_by: "orc", created_at: new Date().toISOString() },
    };
    supStore.insertContract(contract, workerId);
    supStore.insertAttempt({ id: "a_struct", card_id: workerId, contract_id: contract.id, ordinal: 1, executor_kind: "agent", executor_id: "spin", status: "failed", started_at: new Date().toISOString() });

    // Fail the supervised run through the runner with a generic reason: lane
    // evidence still selects the specific lane code for the settler report.
    const { runner, store } = await workflowTools();
    const run = store.findLatestRunByCard(root.id)!;
    const acc = runner.acceptPlan(run.runId, simplePlan());
    runner.attemptFailed(run.runId, acc.nodeIds[0] as string, "att-x", "criteria failed", false);

    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.SupervisedProjectFailure);
    const failure = err as InstanceType<typeof mod.SupervisedProjectFailure>;
    expect(failure.diagnostic.code).toBe("criterion_unevidenced");
    expect(failure.diagnostic.context!.lanes[0]!.missingEvidence).toContain("c1");
  });

  // #1605 Orc-blocked decision precedence retired with the review decision
  // table (no authored block decisions in runner flows; the run's own
  // failure reason is terminal evidence. Lane/definition diagnostics without
  // a decision are covered by the structural test above).
});

describe("scheduled-project-runner #1546 reattach routing", () => {
  async function seedReattachCard(opts: { cardStatus?: string; retryMarker?: string | null }): Promise<number> {
    const root = kanban.kanbanEnqueue("Daily Ai", "task", "daily-ai_1", { type: "O", maxAgents: 4 });
    stateStore.updateActiveRun("daily-ai", "daily-ai_1", { cardId: root });
    if (opts.cardStatus === "queued") {
      const marker = opts.retryMarker ?? new Date(Date.now() + 60_000).toISOString();
      kanban._kanbanExecForTest(`UPDATE kanban_board SET status = 'queued', next_retry_at = ? WHERE id = ?`, [marker, root]);
    } else {
      kanban.kanbanRunning(root);
    }
    return root;
  }

  it("reattach admits idempotently: one run, one planning command, card running", async () => {
    await seedReservation();
    const root = await seedReattachCard({});
    const pending = mod.scheduledProjectRunner(makeRequest());

    expect(kanban.kanbanGetCard(root)?.status).toBe("running");
    const { store } = await workflowTools();
    const runs = store.db.prepare(`SELECT COUNT(*) as cnt FROM workflow_runs WHERE root_card_id = ?`).get(root) as { cnt: number };
    expect(Number(runs.cnt)).toBe(1);
    const plans = store.db.prepare(`SELECT COUNT(*) as cnt FROM workflow_commands WHERE action = 'plan'`).get() as { cnt: number };
    expect(Number(plans.cnt)).toBe(1);

    const run = store.findLatestRunByCard(root)!;
    const { runner } = await workflowTools();
    await succeedRun(runner, run.runId, simplePlan());
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root }));
  });

  it("#1656 binds the canonical workspace before the first claim", async () => {
    await seedReservation();
    const pending = mod.scheduledProjectRunner(makeRequest());

    const root = kanban.kanbanList("*")[0]!;
    const store = new reviewStoreMod.ProjectReviewStore();
    const scope = store.getWorkspaceScope(root.id);
    expect(scope?.cwd).toBe(join(TEST_HOME, "workspace", "daily-ai"));
    expect(scope?.env).toEqual({ WORKSPACE: join(TEST_HOME, "workspace", "daily-ai") });
    expect(store.getSupervision(root.id)!.workspace_cwd).toBe(join(TEST_HOME, "workspace", "daily-ai"));

    const { runner, store: wf } = await workflowTools();
    const run = wf.findLatestRunByCard(root.id)!;
    await succeedRun(runner, run.runId, simplePlan());
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root.id }));
  });

  it("#1656 a reattach with a different cwd fails closed and never rebinds", async () => {
    await seedReservation();
    const root = await seedReattachCard({});
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

    const { runner, store: wf } = await workflowTools();
    await succeedRun(runner, wf.findLatestRunByCard(root)!.runId, simplePlan());
    await expect(pending1).resolves.toEqual(expect.objectContaining({ cardId: root }));
  });

  it("reattach admits idempotently without duplicating planning", async () => {
    await seedReservation();
    const root = await seedReattachCard({});
    const pending = mod.scheduledProjectRunner(makeRequest());

    const { runner, store: wf } = await workflowTools();
    const runs = wf.db.prepare(`SELECT COUNT(*) as cnt FROM workflow_runs WHERE root_card_id = ?`).get(root) as { cnt: number };
    expect(Number(runs.cnt)).toBe(1);
    const plans = wf.db.prepare(`SELECT COUNT(*) as cnt FROM workflow_commands WHERE action = 'plan'`).get() as { cnt: number };
    expect(Number(plans.cnt)).toBe(1);

    await succeedRun(runner, wf.findLatestRunByCard(root)!.runId, simplePlan());
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root }));
  });

  it("terminal reattach reads terminal evidence without admission side effects", async () => {
    await seedReservation();
    const root = kanban.kanbanEnqueue("Daily Ai", "task", "daily-ai_1", { type: "O", maxAgents: 4 });
    // #1590: kanbanComplete is running→done — dispatch first.
    kanban.kanbanRunning(root);
    kanban.kanbanComplete(root, null, "already completed");
    stateStore.updateActiveRun("daily-ai", "daily-ai_1", { cardId: root });

    const result = await mod.scheduledProjectRunner(makeRequest());

    expect(result).toEqual(expect.objectContaining({ cardId: root, result: "already completed" }));
    // No runner admission ran for the terminal card: no run, no commands.
    const { store: wf } = await workflowTools();
    expect(wf.findLatestRunByCard(root)).toBeNull();
    expect(new reviewStoreMod.ProjectReviewStore().getSupervision(root)).toBeUndefined();
  });

  it("a reattached due queued retry promotes and clears its marker", async () => {
    await seedReservation();
    const root = await seedReattachCard({
      cardStatus: "queued",
      retryMarker: new Date(Date.now() - 1000).toISOString(),
    });
    const pending = mod.scheduledProjectRunner(makeRequest());

    expect(kanban.kanbanGetCard(root)?.status).toBe("running");
    expect(kanban.kanbanGetCard(root)?.next_retry_at).toBeNull();

    const { runner, store: wf } = await workflowTools();
    await succeedRun(runner, wf.findLatestRunByCard(root)!.runId, simplePlan());
    await expect(pending).resolves.toEqual(expect.objectContaining({ cardId: root }));
  });

  it("a reattached future queued retry stays queued and keeps its marker", async () => {
    await seedReservation();
    const root = await seedReattachCard({
      cardStatus: "queued",
      retryMarker: new Date(Date.now() + 60_000).toISOString(),
    });
    const control = makeControl("spr-future");
    const pending = mod.scheduledProjectRunner(makeRequest({ executionControl: control }));
    await new Promise(r => setTimeout(r, 20));

    const card = kanban.kanbanGetCard(root)!;
    expect(card.status).toBe("queued");
    expect(card.next_retry_at).not.toBeNull();

    control.signalCancel("operator");
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  // #1628 authoring budgets retired with the Orc-turn protocol (plan-revision
  // budgets in the runner cover correction bounds; see orc-workflow-runner tests).
});
