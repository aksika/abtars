import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("scheduled project orchestration (#1516)", () => {
  let home: string;
  let board: typeof import("../../components/tasks/kanban-board.js");
  let deliverCard: typeof import("../../components/tasks/kanban-delivery.js").deliverCard;
  let CronQueue: typeof import("../../components/tasks/task-queue.js").CronQueue;
  let reconciler: typeof import("../../components/reconciler.js");
  let nerve: typeof import("../../components/nerve.js").nerve;
  let reviewStoreMod: typeof import("../../components/project-acceptance/project-review-store.js");
  let projectRunnerMod: typeof import("../../components/tasks/scheduled-project-runner.js");
  let ScheduledRunCoordinator: typeof import("../../components/tasks/scheduled-run-coordinator.js").ScheduledRunCoordinator;
  let toolRegistryMod: typeof import("../../components/transport/tool-registry.js");
  let WorkflowRunner: typeof import("../../components/orc-project/orc-workflow-runner.js").WorkflowRunner;
  let WorkflowStore: typeof import("../../components/orc-project/orc-workflow-store.js").WorkflowStore;

  // This fixture deliberately resets and re-imports the full reconciler graph
  // against a fresh mocked home. Keep its setup budget local to this test: the
  // integration portfolio may be CPU-cold after earlier files, but product
  // lifecycle waits retain their own bounded assertions (#1723).
  beforeEach(async () => {
    vi.resetModules();
    home = join(tmpdir(), `abtars-scheduled-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => home, abmindHome: () => join(home, "..", "abmind-test") }));
    board = await import("../../components/tasks/kanban-board.js");
    ({ deliverCard } = await import("../../components/tasks/kanban-delivery.js"));
    ({ CronQueue } = await import("../../components/tasks/task-queue.js"));
    reconciler = await import("../../components/reconciler.js");
    nerve = (await import("../../components/nerve.js")).nerve;
    reviewStoreMod = await import("../../components/project-acceptance/project-review-store.js");
    projectRunnerMod = await import("../../components/tasks/scheduled-project-runner.js");
    ScheduledRunCoordinator = (await import("../../components/tasks/scheduled-run-coordinator.js")).ScheduledRunCoordinator;
    toolRegistryMod = await import("../../components/transport/tool-registry.js");
    WorkflowRunner = (await import("../../components/orc-project/orc-workflow-runner.js")).WorkflowRunner;
    WorkflowStore = (await import("../../components/orc-project/orc-workflow-store.js")).WorkflowStore;
  }, 30_000);

  afterEach(async () => {
    await activeHandle?.stop();
    activeHandle = null;
    wakeScheduler?.stop();
    wakeScheduler = null;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });


let activeHandle: import("../../components/reconciler.js").ReconcilerHandle | null = null;
let wakeScheduler: import("../../components/lifecycle-wake-scheduler.js").LifecycleWakeScheduler | null = null;

/**
 * #1707: a scheduled root's occurrence is resolved through the durable task
 * catalog (findActiveScheduledOccurrence -> readEntries). An entry that is
 * only in the queue is swept as an orphan by initializeState(), which deletes
 * its task_runs reservation — the gate then reads the root as terminal and the
 * reconciler last-resort-settles it to blocked. Register before enqueueing so
 * the fixture matches how production always admits a scheduled run (#1723).
 */
async function registerAndEnqueue(
  queue: InstanceType<typeof CronQueue>,
  entry: import("../../components/tasks/task-types.js").ScheduledTask,
): Promise<void> {
  const taskStore = await import("../../components/tasks/task-store.js");
  taskStore.writeEntry(entry);
  queue.enqueue(entry, true);
}

/** #1554: start a real generation over the tmpdir stores with a scripted coordinator. */
async function startGeneration(coordinator: unknown): Promise<void> {
  const { LifecycleWakeScheduler } = await import("../../components/lifecycle-wake-scheduler.js");
  const { SpinWorkerAdapter } = await import("../../components/spin-worker-adapter.js");
  const { ReconcileQuarantineStore } = await import("../../components/reconcile-quarantine-store.js");
  await activeHandle?.stop();
  activeHandle = null;
  wakeScheduler?.stop();
  wakeScheduler = new LifecycleWakeScheduler();
  activeHandle = await reconciler.startReconciler({
    generationId: `scheduled-project-${Date.now()}`,
    coordinator: ({
      getStore: () => ({ countStartedAuthoringTurns: () => 0, countConsecutiveUnstartableAuthoringTurns: () => 0, lastAuthoringClaimAt: () => null, lastAuthoringFailureCode: () => null }),
      bootRecovery: () => [] as number[],
      onOwnershipReleased: () => () => {},
      ...(coordinator as Record<string, unknown> | undefined),
    }) as never,
    wakeScheduler,
    workerAdapter: new SpinWorkerAdapter(),
    piService: null,
    createPiAdapter: (() => ({ kind: "pi", capacity: async () => ({ available: 0, max: 0 }), start: async () => ({ kind: "start_failed", reason: "unavailable", retryable: false }), cancel: async () => ({ kind: "cancelled", attemptId: "" }), inspect: async () => ({ kind: "running", lifecycle: "running" }) })) as never,
    getQuarantineStore: () => new ReconcileQuarantineStore(),
    projectRunProgress: () => {},
  } as never);
  await wakeScheduler.start();
}

  async function waitForIdle(queue: { currentJob: unknown }): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (queue.currentJob && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(queue.currentJob).toBeNull();
  }

  it("runs one scheduled project with three lanes, validates the Orc artifact, settles once, and delivers", async () => {
    // #1792: the scheduled project runs through the real WorkflowRunner —
    // admission with the scheduled occurrence identity, a three-lane plan
    // with an explicit writer node, scripted worker execution, review
    // verdict, and delivery execution. Deleted vs the old journey: the Orc
    // coordinator contract-authoring claim (the schedule dispatch path is
    // retired — the reconciler never dispatches), the spin worker-slot
    // capacity check (slot admission retired with the supervised brain;
    // runner budgets bound the run instead), and the scheduler history
    // assertion (history settlement belongs to the scheduler settler,
    // covered by scheduler-journey.e2e — exactly-once is proven here at the
    // runner level: late results rejected, one delivery obligation).
    const artifactPath = join(home, "workspace", "brief-task", "brief.md");
    mkdirSync(join(home, "workspace", "brief-task"), { recursive: true });

    const taskStore = await import("../../components/tasks/task-store.js");
    const stateStore = await import("../../components/tasks/task-state-store.js");
    const entry: import("../../components/tasks/task-types.js").ScheduledTask = {
      id: "brief-task", kind: "agent", prompt: "produce the briefing",
      agent: "task", interaction: { mode: "oneshot" }, delivery: "report", at: new Date().toISOString(),
      enabled: true, priority: "medium", chatId: "42",
      orchestration: { maxAgents: 4 },
      report: {
        artifact: artifactPath,
        requiredSections: ["# Brief"],
        minBytes: 100,
        requires: { files: [], executables: [], tools: [] },
      },
    };
    mkdirSync(join(home, "tasks"), { recursive: true });
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([entry], null, 2));
    stateStore.initializeState(taskStore.readEntries());
    const now = Date.now();
    const runId = `brief-task_run_${now}`;
    stateStore.reserveRun(entry.id, {
      runId,
      groupId: `${entry.id}:group:${now}`,
      attempt: 1 as const,
      trigger: "schedule" as const,
      occurrenceAt: now,
      deadlineAt: now + 600_000,
    });

    // Production admission shape (#1516): the root card durably carries the
    // scheduled run correlation and the agent cap.
    const rootId = board.kanbanEnqueue("Daily Briefing", "task", runId, {
      type: "O", goal: "produce the briefing", maxAgents: 4,
      due_at: new Date(now + 600_000).toISOString(), delivery: "report", chatId: "42",
      deliveryReady: false,
    });
    stateStore.updateActiveRun(entry.id, runId, { cardId: rootId });
    const root = board.kanbanGetCard(rootId)!;
    expect(root.type).toBe("O");
    expect(root.max_agents).toBe(4);
    expect(root.source).toBe("task");
    expect(root.delivery_ready).toBe(0);

    const runner = new WorkflowRunner(new WorkflowStore(), ["general", "research", "write"]);
    const admitted = runner.admitSupervised({
      rootCardId: rootId, source: "task", sourceId: runId, scheduledRunId: runId,
      cwd: join(home, "workspace", "brief-task"),
    });
    expect(admitted.kind).toBe("admitted");
    expect(admitted.rootKind).toBe("scheduled");
    board.kanbanRunning(rootId);

    // Three independent lanes plus the sole-writer synthesis node and review.
    const acc = runner.acceptPlan(admitted.runId as string, {
      requiredOutputs: ["brief"],
      nodes: [
        { label: "lane-1", kind: "work", instructions: "research lane 1", capability: "research", outputs: ["notes-1"], acceptance: ["thorough"], dependsOn: [] },
        { label: "lane-2", kind: "work", instructions: "research lane 2", capability: "research", outputs: ["notes-2"], acceptance: ["thorough"], dependsOn: [] },
        { label: "lane-3", kind: "work", instructions: "research lane 3", capability: "research", outputs: ["notes-3"], acceptance: ["thorough"], dependsOn: [] },
        { label: "writer", kind: "synthesis", instructions: "write the briefing", capability: "write", outputs: ["brief"], acceptance: ["complete"], dependsOn: ["lane-1", "lane-2", "lane-3"] },
        { label: "judge", kind: "review", instructions: "assess", capability: "general", outputs: [], acceptance: [], dependsOn: ["writer"] },
      ],
    });
    const dispatched: string[] = [];
    const ports = {
      executor: { name: "sched-exec", dispatch: (cmd: { nodeId: string }) => { dispatched.push(cmd.nodeId); } },
      reviewer: { name: "sched-reviewer", startReview: (_cmd: unknown, _brief: unknown) => {} },
      planner: { name: "sched-planner", startPlanning: (_cmd: unknown, _input: unknown) => {} },
    };
    runner.drain(10, ports);
    expect([acc.nodeIds[0], acc.nodeIds[1], acc.nodeIds[2]].every(n => dispatched.includes(n as string))).toBe(true);

    // Three lanes run to completion under the project root.
    runner.attemptSucceeded(admitted.runId as string, acc.nodeIds[0] as string, "att-lane-1", "{}");
    runner.attemptSucceeded(admitted.runId as string, acc.nodeIds[1] as string, "att-lane-2", "{}");
    runner.attemptSucceeded(admitted.runId as string, acc.nodeIds[2] as string, "att-lane-3", "{}");
    runner.drain(10, ports);
    expect(dispatched).toContain(acc.nodeIds[3]);

    // The writer produces the final artifact; the entry's report contract
    // (required sections + minimum size) validates it like production does.
    writeFileSync(artifactPath, "# Brief\n" + "line\n".repeat(30));
    const reportBody = (await import("node:fs")).readFileSync(artifactPath, "utf8");
    expect(entry.report!.requiredSections!.every(s => reportBody.includes(s))).toBe(true);
    expect(Buffer.byteLength(reportBody)).toBeGreaterThanOrEqual(entry.report!.minBytes!);
    runner.attemptSucceeded(admitted.runId as string, acc.nodeIds[3] as string, "att-writer", JSON.stringify({ artifact: artifactPath }));
    runner.drain(10, ports);

    // The review judges the recorded writer outcome against the real file.
    const brief = runner.assembleBrief(admitted.runId as string, 1, acc.nodeIds[4] as string);
    const writerOutcome = JSON.parse(
      (brief.nodes.find((n) => n.nodeId === acc.nodeIds[3])?.outcome ?? "{}") as string,
    ) as { artifact?: string };
    expect(writerOutcome.artifact).toBe(artifactPath);
    expect(existsSync(writerOutcome.artifact as string)).toBe(true);
    expect(runner.submitVerdict(admitted.runId as string, acc.nodeIds[4] as string, { verdict: "accept" })).toBe("accepted");
    expect(runner.store.getRun(admitted.runId as string)?.state).not.toBe("succeeded");
    const sender = { name: "sched-sender", send: (doc: { runId: string; nodeId: string; obligation: string; idempotenceKey: string }) => `receipt:${doc.idempotenceKey}` };
    expect(runner.executeDelivery(admitted.runId as string, acc.nodeIds[4] as string, sender)).toBe("acknowledged");
    expect(runner.store.getRun(admitted.runId as string)?.state).toBe("succeeded");

    // Settles once: late lane results on the terminal run change nothing.
    expect(() => runner.attemptSucceeded(admitted.runId as string, acc.nodeIds[0] as string, "att-late", "{}"))
      .toThrow(/terminal.*late result rejected/);

    const done = board.kanbanList("done").filter(c => c.type === "O");
    expect(done).toHaveLength(1);
    expect(done[0]!.id).toBe(rootId);
    expect(done[0]!.result_path).toBe(artifactPath);
    expect(typeof done[0]!.result_summary).toBe("string");
    expect(existsSync(done[0]!.result_path!)).toBe(true);

    // #1663: the scheduled Orc cannot deliver directly. A forged
    // authorizationMode argument does not help; the trusted unattended mode
    // comes from the durable task-sourced root and the shared execution
    // boundary denies before any platform callback.
    const sendSpy = vi.fn().mockResolvedValue(9999);
    toolRegistryMod.setSendDocument(sendSpy as never);
    for (let i = 0; i < 2; i++) {
      const attempt = await toolRegistryMod.executeToolCall("send_document", {
        path: artifactPath,
        caption: `Daily Briefing ${i}`,
        authorizationMode: "interactive", // forged — must be ignored
      }, {
        userId: "test",
        authorizationMode: "unattended-task",
      });
      const parsed = JSON.parse(attempt) as { reason?: string };
      expect(parsed.reason).toBe("unattended_scheduled_delivery");
    }
    expect(sendSpy).not.toHaveBeenCalled();

    // Occurrence close (scheduler settler's durable effect, via SQL time
    // travel as in scheduler-journey.e2e) lets the projection redrive release
    // delivery — exactly once under repeated polling.
    runner.store.db.prepare(`UPDATE task_runs SET finished_at = ?, outcome = 'success' WHERE run_id = ?`)
      .run(Date.now(), runId);
    expect(runner.projectTerminalProjections(admitted.runId as string)).toBe(true);
    expect(board.kanbanGetCard(rootId)!.delivery_ready).toBe(1);

    const deps = {
      sendMessage: vi.fn().mockResolvedValue("sent" as const),
      sendDocument: vi.fn().mockResolvedValue("sent" as const),
      announce: vi.fn().mockResolvedValue(undefined),
      chatIdFor: vi.fn().mockReturnValue("42"),
    };
    // #1663: repeated delivery polling claims and sends exactly once.
    await deliverCard(done[0]!, deps);
    await deliverCard(board.kanbanGetCard(rootId)!, deps);
    await deliverCard(board.kanbanGetCard(rootId)!, deps);
    expect(deps.sendDocument).toHaveBeenCalledOnce();
    expect(board.kanbanGetCard(rootId)!.status).toBe("delivered");
    expect(board.kanbanGetCard(rootId)!.delivery_attempts).toBe(1);
    expect(board.kanbanGetCard(rootId)!.delivery_result).toBe("sent");
    // The direct unattended attempts never produced a platform send.
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("never settles success or delivers when the project accepts but the artifact is stale", async () => {
    const artifactPath = join(home, "workspace", "stale-task", "stale.md");
    mkdirSync(join(home, "workspace", "stale-task"), { recursive: true });

    await startGeneration({
      scheduleContractAuthoring() {
        return { kind: "claimed", context: { runId: "or_test", projectCardId: 1 } };
      },
    } as never);

    const queue = new CronQueue(new ScheduledRunCoordinator({ projectRunner: projectRunnerMod.scheduledProjectRunner }));
    const entry: import("../../components/tasks/task-types.js").ScheduledTask = {
      id: "stale-task", kind: "agent", prompt: "produce report",
      agent: "task", interaction: { mode: "oneshot" }, delivery: "report", at: new Date().toISOString(),
      enabled: true, priority: "medium", chatId: "42",
      orchestration: { maxAgents: 2 },
      report: {
        artifact: artifactPath,
        requiredSections: ["# Report"],
        minBytes: 100,
        requires: { files: [], executables: [], tools: [] },
      },
    };
    await registerAndEnqueue(queue, entry);

    const deadline = Date.now() + 3_000;
    let rootId = 0;
    while (rootId === 0 && Date.now() < deadline) {
      const cards = board.kanbanList("*").filter(c => c.type === "O");
      if (cards.length > 0) rootId = cards[0]!.id;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(rootId).toBeGreaterThan(0);

    // Accepted before the reservation — the artifact predates the run.
    writeFileSync(artifactPath, "# Report\n" + "line\n".repeat(30));
    const stat = await import("node:fs");
    stat.utimesSync(artifactPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleAcceptance(rootId, "case-stale", { synthesis: "s" }, "s", undefined, "rd_stale");
    nerve.fire("card:done", rootId);

    await waitForIdle(queue);

    const historyStore = await import("../../components/tasks/task-history-store.js");
    const evs = historyStore.recentRuns("stale-task", 5);
    expect(evs.some(e => e.outcome === "failed")).toBe(true);
    expect(evs.filter(e => e.outcome === "success")).toHaveLength(0);
    const failed = board.kanbanList("failed");
    expect(failed.some(c => c.id === rootId)).toBe(true);
  });

  // #1663: a non-accepting Orc decision (blocked/repair/needs_input) must
  // never unlock delivery — the root is not done and no platform send can
  // happen, even under repeated polling.
  it("never delivers when the Orc decision is blocked instead of accepted", async () => {
    const rootId = board.kanbanEnqueue("blocked-project", "agent", undefined, { type: "O", maxAgents: 2 });
    board.kanbanRunning(rootId);
    const store = new reviewStoreMod.ProjectReviewStore();
    reviewStoreMod.initializeProjectSupervision(store, rootId, "contract-blocked");
    expect(store.blockProject(rootId, "control: blocked decision")).toBe(true);

    const failedCard = board.kanbanGetCard(rootId)!;
    expect(failedCard.status).toBe("failed");
    expect(failedCard.delivery_result).toBeNull();

    const deps = {
      sendMessage: vi.fn().mockResolvedValue("sent" as const),
      sendDocument: vi.fn().mockResolvedValue("sent" as const),
      announce: vi.fn().mockResolvedValue(undefined),
      chatIdFor: vi.fn().mockReturnValue("42"),
    };
    await deliverCard(board.kanbanGetCard(rootId)!, deps);
    await deliverCard(board.kanbanGetCard(rootId)!, deps);
    expect(deps.sendDocument).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(board.kanbanGetCard(rootId)!.status).toBe("failed");
    expect(board.kanbanGetCard(rootId)!.delivery_attempts).toBe(0);
  });

  // #1735 Task 6: catalog unavailable defers scheduled admission and recovers after restore.
  // Keeps #1723 registration fixture: production admission always starts from a catalog entry.
  // #1792: the reconciler last-resort settlement trigger and the coordinator
  // scheduleProjectExecution claim no longer exist (the schedule dispatch path
  // is retired — the runner owns liveness). Deleted vs the old journey: both
  // reconciler.requestReconcile triggers, both scheduleProjectExecution
  // assertions, and the Orc run-store row counts. Preserved: the gate truth
  // (unavailable, never terminal), untouched live rows, no history
  // settlement, and recovery expressed as runner admission + plan + verdict
  // after the catalog is restored (with duplicate admission staying a
  // duplicate, never a second run).
  it("defers scheduled admission when catalog is unreadable and recovers after restore — live rows untouched", async () => {
    const taskStore = await import("../../components/tasks/task-store.js");
    const stateStore = await import("../../components/tasks/task-state-store.js");
    const gateMod = await import("../../components/tasks/scheduled-occurrence-gate.js");

    const ENTRY: import("../../components/tasks/task-types.js").ScheduledTask = {
      id: "recovery-task", kind: "agent", prompt: "recoverable work",
      agent: "task", interaction: { mode: "oneshot" }, delivery: "silent",
      schedule: "* * * * *", enabled: true, priority: "medium", chatId: "42",
      orchestration: { maxAgents: 2 },
    };

    // Seed catalog and live scheduled project (matches #1723 production fixture).
    mkdirSync(join(home, "tasks"), { recursive: true });
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));
    const entries = taskStore.readEntries();
    // initializeState is additive — calling here registers the task_state row
    const { initializeState } = stateStore;
    initializeState(entries);
    const now = Date.now();
    const runId = `${ENTRY.id}_recovery_${now}`;
    stateStore.reserveRun(ENTRY.id, {
      runId,
      groupId: `${ENTRY.id}:group:${now}`,
      attempt: 1 as const,
      trigger: "schedule" as const,
      occurrenceAt: now,
      deadlineAt: now + 600_000,
    });
    const run = stateStore.readState(ENTRY.id)!.activeRun!;
    const rootId = board.kanbanEnqueue("Recovery Project", "task", run.runId, { type: "O", goal: "supervised work", maxAgents: 2 });
    stateStore.updateActiveRun(ENTRY.id, run.runId, { cardId: rootId });
    const store = new reviewStoreMod.ProjectReviewStore();
    const contract: import("../../components/project-acceptance/project-contract.js").ProjectAcceptanceContractV1 = {
      schema_version: 1, id: `ct_${rootId}`, digest: `dg_${rootId}`, project_card_id: rootId,
      goal: "supervised work",
      criteria: [{ id: "c1", description: "goal met", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [], constraints: [], limits: { max_review_rounds: 3, max_repair_rounds: 2 },
      provenance: { requested_by: "scheduler", authored_by: "orc", created_at: new Date().toISOString() },
    };
    store.insertContract(contract);
    store.initializeSupervision(rootId, `ct_${rootId}`, "executing" as never);
    board.kanbanRunning(rootId);

    const runner = new WorkflowRunner(new WorkflowStore(), ["general", "research", "write"]);

    // Snapshot durable state before the outage.
    const beforeState = stateStore.readState(ENTRY.id)!;
    expect(beforeState.activeRun?.runId).toBe(run.runId);
    const beforeCard = board.kanbanGetCard(rootId)!;
    expect(beforeCard.status).toBe("running");
    const beforeSup = store.getSupervision(rootId)!;
    expect(beforeSup.state).toBe("executing");
    expect(runner.store.findRunByCard(rootId)).toBeNull();
    expect(gateMod.inspectScheduledOccurrence(beforeCard).state).toBe("active");

    // Make catalog unreadable — invalid JSON (unavailable).
    writeFileSync(join(home, "tasks", "tasks.json"), "INVALID JSON {{{");

    // While the catalog is unavailable the scheduler cannot verify the
    // definition, so nothing is admitted: live rows stay untouched, no
    // runner run exists, no supervision transition, no settlement.
    const midState = stateStore.readState(ENTRY.id)!;
    expect(midState.activeRun?.runId).toBe(run.runId);
    expect(board.kanbanGetCard(rootId)!.status).toBe("running");
    expect(store.getSupervision(rootId)!.state).toBe("executing");
    expect(runner.store.findRunByCard(rootId)).toBeNull();
    // Gate must report unavailable, not terminal.
    const midCard = board.kanbanGetCard(rootId)!;
    const midInspection = gateMod.inspectScheduledOccurrence(midCard);
    expect(midInspection.state).toBe("unavailable");
    if (midInspection.state === "unavailable") {
      expect(midInspection.reason).toBe("definition_unavailable");
    }
    // No history settlement.
    const histMod = await import("../../components/tasks/task-history-store.js");
    expect(histMod.recentRuns(ENTRY.id, 10).filter(r => r.outcome === "failed" && r.kanbanCardId === rootId)).toHaveLength(0);

    // Restore valid catalog.
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([ENTRY], null, 2));

    // The gate is active again: admit through the runner and drive the run to
    // an accepted delivery.
    const afterCard = board.kanbanGetCard(rootId)!;
    expect(gateMod.inspectScheduledOccurrence(afterCard).state).toBe("active");
    const admitted = runner.admitSupervised({ rootCardId: rootId, source: "task", sourceId: run.runId, scheduledRunId: run.runId });
    expect(admitted.kind).toBe("admitted");
    expect(admitted.rootKind).toBe("scheduled");
    // A repeated admission while the run is live is a duplicate, never a
    // second run.
    const again = runner.admitSupervised({ rootCardId: rootId, source: "task", sourceId: run.runId, scheduledRunId: run.runId });
    expect(again.kind).toBe("duplicate");
    expect(again.runId).toBe(admitted.runId);

    const acc = runner.acceptPlan(admitted.runId as string, {
      requiredOutputs: ["result"],
      nodes: [
        { label: "work", kind: "work", instructions: "recoverable work", capability: "research", outputs: ["result"], acceptance: ["done"], dependsOn: [] },
        { label: "judge", kind: "review", instructions: "assess", capability: "general", outputs: [], acceptance: [], dependsOn: ["work"] },
      ],
    });
    const ports = {
      executor: { name: "recovery-exec", dispatch: (_cmd: unknown) => {} },
      reviewer: { name: "recovery-reviewer", startReview: (_cmd: unknown, _brief: unknown) => {} },
      planner: { name: "recovery-planner", startPlanning: (_cmd: unknown, _input: unknown) => {} },
    };
    runner.drain(10, ports);
    runner.attemptSucceeded(admitted.runId as string, acc.nodeIds[0] as string, "att-recovery", "{}");
    runner.drain(10, ports);
    expect(runner.submitVerdict(admitted.runId as string, acc.nodeIds[1] as string, { verdict: "accept" })).toBe("accepted");
    const sender = { name: "recovery-sender", send: (_doc: { idempotenceKey: string }) => "receipt" };
    expect(runner.executeDelivery(admitted.runId as string, acc.nodeIds[1] as string, sender)).toBe("acknowledged");
    expect(runner.store.getRun(admitted.runId as string)?.state).toBe("succeeded");
    expect(board.kanbanGetCard(rootId)!.status).toBe("done");
    expect(runner.auditTick(0).ownerless).not.toContain(admitted.runId);
  });
});
