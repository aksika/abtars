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
  let nerve: import("node:events").EventEmitter;
  let reviewStoreMod: typeof import("../../components/project-acceptance/project-review-store.js");
  let projectRunnerMod: typeof import("../../components/tasks/scheduled-project-runner.js");
  let ScheduledRunCoordinator: typeof import("../../components/tasks/scheduled-run-coordinator.js").ScheduledRunCoordinator;
  let toolRegistryMod: typeof import("../../components/transport/tool-registry.js");

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
  });

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
    const artifactPath = join(home, "workspace", "brief-task", "brief.md");
    mkdirSync(join(home, "workspace", "brief-task"), { recursive: true });

    const claims: Array<{ projectCardId: number; goal: string }> = [];
    await startGeneration({
      scheduleScheduledProject(projectCardId: number, goal: string) {
        claims.push({ projectCardId, goal });
        return { kind: "claimed", context: { runId: "or_test", projectCardId } };
      },
    } as never);

    const queue = new CronQueue(new ScheduledRunCoordinator({ projectRunner: projectRunnerMod.scheduledProjectRunner }));
    queue.enqueue({
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
    }, true);

    const deadline = Date.now() + 3_000;
    while (claims.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(claims).toHaveLength(1);
    const rootId = claims[0]!.projectCardId;
    expect(claims[0]!.goal).toContain("Agent budget: 4 total agents (1 Orc + up to 3");
    expect(claims[0]!.goal).toContain("sole writer");

    const root = board.kanbanGetCard(rootId)!;
    expect(root.type).toBe("O");
    expect(root.max_agents).toBe(4);
    expect(root.source).toBe("task");
    expect(root.delivery_ready).toBe(0);

    // Three independent lanes run to completion under the project root.
    const laneIds = [1, 2, 3].map(i => {
      const w = board.kanbanEnqueue(`lane-${i}`, "agent", undefined, { type: "W", parent_id: rootId });
      board.kanbanRunning(w);
      board.kanbanComplete(w, null, `lane ${i} evidence`);
      return w;
    });
    expect(new Set(laneIds).size).toBe(3);
    // Terminal lanes release capacity (#1516 req 7): a fresh admission is
    // permitted again once all three lanes reached a terminal card.
    expect(board.checkWorkerSlotForProject(rootId)).toEqual({ ok: true });

    // The Orc writes the final artifact and the review accepts the project.
    writeFileSync(artifactPath, "# Brief\n" + "line\n".repeat(30));

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

    const store = new reviewStoreMod.ProjectReviewStore();
    store.settleAcceptance(rootId, "case-e2e", { synthesis: "briefing synthesized" }, "briefing synthesized", undefined, "rd_e2e");
    nerve.fire("card:done", rootId);

    await waitForIdle(queue);

    const done = board.kanbanList("done").filter(c => c.type === "O");
    expect(done).toHaveLength(1);
    expect(done[0]!.id).toBe(rootId);
    expect(done[0]!.result_path).toBe(artifactPath);
    expect(done[0]!.result_summary).toContain("artifact");
    expect(done[0]!.delivery_ready).toBe(1);
    expect(existsSync(done[0]!.result_path!)).toBe(true);

    const historyStore = await import("../../components/tasks/task-history-store.js");
    const evs = historyStore.recentRuns("brief-task", 5);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.outcome).toBe("success");
    expect(evs[0]!.kanbanCardId).toBe(rootId);

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
      scheduleScheduledProject() {
        return { kind: "claimed", context: { runId: "or_test", projectCardId: 1 } };
      },
    } as never);

    const queue = new CronQueue(new ScheduledRunCoordinator({ projectRunner: projectRunnerMod.scheduledProjectRunner }));
    queue.enqueue({
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
    }, true);

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
});
