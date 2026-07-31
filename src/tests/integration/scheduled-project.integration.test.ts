import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
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

  beforeEach(async () => {
    vi.resetModules();
    home = join(tmpdir(), `abtars-scheduled-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
    board = await import("../../components/tasks/kanban-board.js");
    ({ deliverCard } = await import("../../components/tasks/kanban-delivery.js"));
    ({ CronQueue } = await import("../../components/tasks/task-queue.js"));
    reconciler = await import("../../components/reconciler.js");
    nerve = (await import("../../components/nerve.js")).nerve;
    reviewStoreMod = await import("../../components/project-acceptance/project-review-store.js");
    projectRunnerMod = await import("../../components/tasks/scheduled-project-runner.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

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
    reconciler.setOrcCoordinator({
      scheduleScheduledProject(projectCardId: number, goal: string) {
        claims.push({ projectCardId, goal });
        return { kind: "claimed", context: { runId: "or_test", projectCardId } };
      },
    } as never);

    const queue = new CronQueue("unused", home, undefined, undefined, undefined, projectRunnerMod.scheduledProjectRunner);
    queue.enqueue({
      id: "brief-task", kind: "agent", prompt: "produce the briefing",
      agent: "task", delivery: "report", at: new Date().toISOString(),
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

    const history = readFileSync(join(home, "tasks", "task-history.jsonl"), "utf8");
    expect(history).toContain('"outcome":"success"');
    expect(history).toContain(`"kanbanCardId":${rootId}`);

    const deps = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
      announce: vi.fn().mockResolvedValue(undefined),
      chatIdFor: vi.fn().mockReturnValue("42"),
    };
    await deliverCard(done[0]!, deps);
    expect(deps.sendDocument).toHaveBeenCalledOnce();
    expect(board.kanbanGetCard(rootId)!.status).toBe("delivered");
    expect(board.kanbanGetCard(rootId)!.delivery_attempts).toBe(1);
  });

  it("never settles success or delivers when the project accepts but the artifact is stale", async () => {
    const artifactPath = join(home, "workspace", "stale-task", "stale.md");
    mkdirSync(join(home, "workspace", "stale-task"), { recursive: true });

    reconciler.setOrcCoordinator({
      scheduleScheduledProject() {
        return { kind: "claimed", context: { runId: "or_test", projectCardId: 1 } };
      },
    } as never);

    const queue = new CronQueue("unused", home, undefined, undefined, undefined, projectRunnerMod.scheduledProjectRunner);
    queue.enqueue({
      id: "stale-task", kind: "agent", prompt: "produce report",
      agent: "task", delivery: "report", at: new Date().toISOString(),
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

    const history = readFileSync(join(home, "tasks", "task-history.jsonl"), "utf8");
    expect(history).toContain('"outcome":"failed"');
    expect(history).not.toContain('"outcome":"success"');
    const failed = board.kanbanList("failed");
    expect(failed.some(c => c.id === rootId)).toBe(true);
  });
});
