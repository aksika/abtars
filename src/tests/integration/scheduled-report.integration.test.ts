import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("scheduled report acceptance (#1502 Task 12)", () => {
  let home: string;
  let board: typeof import("../../components/tasks/kanban-board.js");
  let deliverCard: typeof import("../../components/tasks/kanban-delivery.js").deliverCard;
  let CronQueue: typeof import("../../components/tasks/task-queue.js").CronQueue;
  let ScheduledRunCoordinator: typeof import("../../components/tasks/scheduled-run-coordinator.js").ScheduledRunCoordinator;

  beforeEach(async () => {
    vi.resetModules();
    home = join(tmpdir(), `abtars-scheduled-report-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
    board = await import("../../components/tasks/kanban-board.js");
    ({ deliverCard } = await import("../../components/tasks/kanban-delivery.js"));
    ({ CronQueue } = await import("../../components/tasks/task-queue.js"));
    ScheduledRunCoordinator = (await import("../../components/tasks/scheduled-run-coordinator.js")).ScheduledRunCoordinator;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  async function waitForIdle(queue: { currentJob: unknown }): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (queue.currentJob && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(queue.currentJob).toBeNull();
  }

  it("runs, validates, settles, and delivers one report through real queue and stores", async () => {
    const logger = await import("../../components/logger.js");
    logger.setLogLevel("trace");
    logger.setFileLogging(true);
    const canary = "PROMPT_CONTEXT_COMMAND_STDERR_ENV_ASSISTANT_CANARY";
    const artifactPath = join(home, "workspace", "report-task", "report.md");
    mkdirSync(join(home, "workspace", "report-task"), { recursive: true });
    writeFileSync(join(home, "workspace", "report-task", "CONTEXT.md"), canary);
    const modelBoundary = vi.fn(async (request: import("../../components/spin-types.js").SpinRequest) => {
      const cardId = board.kanbanEnqueue(request.title ?? "scheduled report", "task", "report-task", {
        type: request.type,
        goal: request.goal,
        delivery: request.delivery,
        chatId: request.chatId ? String(request.chatId) : undefined,
      });
      board.kanbanRunning(cardId);
      writeFileSync(artifactPath, "# Report\n" + `${canary} report line\n`.repeat(20));
      return { cardId, result: `${canary} report line\n`.repeat(20) };
    });
    const queue = new CronQueue(new ScheduledRunCoordinator({ agentRunner: modelBoundary }));
    queue.enqueue({
      id: "report-task", kind: "agent", prompt: `${canary} produce report`,
      agent: "task", interaction: { mode: "oneshot" }, delivery: "report", at: new Date().toISOString(),
      enabled: true, priority: "medium", chatId: "42",
      report: {
        artifact: artifactPath,
        requiredSections: ["# Report"],
        minBytes: 100,
        requires: { files: [], executables: [], tools: [] },
      },
    }, true);

    await waitForIdle(queue);
    expect(modelBoundary).toHaveBeenCalledOnce();
    const request = modelBoundary.mock.calls[0]![0];
    expect(request.executionScope?.cwd).toBe(join(home, "workspace", "report-task"));
    expect(request.executionScope?.env.WORKSPACE).toBe(request.executionScope.cwd);
    expect(process.env.WORKSPACE).toBeUndefined();

    const done = board.kanbanList("done");
    expect(done).toHaveLength(1);
    expect(done[0]!.result_path).toBe(artifactPath);
    expect(existsSync(done[0]!.result_path!)).toBe(true);

    const deps = {
      sendMessage: vi.fn().mockResolvedValue("sent" as const),
      sendDocument: vi.fn().mockResolvedValue("sent" as const),
      announce: vi.fn().mockResolvedValue(undefined),
      chatIdFor: vi.fn().mockReturnValue("42"),
    };
    await deliverCard(done[0]!, deps);
    expect(deps.sendDocument).toHaveBeenCalledOnce();
    expect(board.kanbanGetCard(done[0]!.id)!.status).toBe("delivered");
    expect(board.kanbanGetCard(done[0]!.id)!.delivery_attempts).toBe(1);

    const history = readFileSync(join(home, "tasks", "task-history.jsonl"), "utf8");
    expect(history).toContain('"outcome":"success"');
    expect(history).toContain('"kanbanCardId":1');
    logger.flushLogs();
    const logPath = logger.getLogFile();
    const logs = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    expect(logs).toContain("task_execution_started");
    expect(logs).toContain("task_settled");
    expect(logs).not.toContain(canary);
  });

  it("does not deliver a report when the final response is below the report threshold", async () => {
    const modelBoundary = vi.fn(async (request: import("../../components/spin-types.js").SpinRequest) => {
      const cardId = board.kanbanEnqueue(request.title ?? "scheduled report", "task", "short-task", {
        type: request.type, delivery: request.delivery,
      });
      board.kanbanRunning(cardId);
      return { cardId, result: "too short" };
    });
    const queue = new CronQueue(new ScheduledRunCoordinator({ agentRunner: modelBoundary }));
    queue.enqueue({
      id: "short-task", kind: "agent", prompt: "produce report",
      agent: "task", interaction: { mode: "oneshot" }, delivery: "report", at: new Date().toISOString(),
      enabled: true, priority: "medium",
      report: {
        artifact: join(home, "workspace", "short-task", "report.md"),
        requiredSections: ["# test"],
        minBytes: 100,
        requires: { files: [], executables: [], tools: [] },
      },
    }, true);
    await waitForIdle(queue);

    const failed = board.kanbanList("failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.status).toBe("failed");
    // The delivery poll consumes done/pending cards only; a failed report has
    // no success delivery candidate and remains visibly failed for retry policy.
  });

  it("treats a verified structured report contract artifact as authoritative", async () => {
    const artifact = join(home, "workspace", "dod-task", "report.md");
    mkdirSync(join(home, "workspace", "dod-task"), { recursive: true });

    const modelBoundary = vi.fn(async (request: import("../../components/spin-types.js").SpinRequest) => {
      writeFileSync(artifact, "# Verified report\n" + "content\n".repeat(30));
      const cardId = board.kanbanEnqueue(request.title ?? "scheduled report", "task", "dod-task", { type: request.type, delivery: request.delivery });
      board.kanbanRunning(cardId);
      return { cardId, result: "ok" };
    });
    const queue = new CronQueue(new ScheduledRunCoordinator({ agentRunner: modelBoundary }));
    queue.enqueue({
      id: "dod-task", kind: "agent", prompt: "produce report",
      agent: "task", interaction: { mode: "oneshot" }, delivery: "report", at: new Date().toISOString(), enabled: true, priority: "medium",
      report: {
        artifact,
        requiredSections: ["# Verified report"],
        minBytes: 100,
        requires: { files: [], executables: [], tools: [] },
      },
    }, true);

    await vi.waitFor(() => expect(modelBoundary).toHaveBeenCalledOnce(), { timeout: 2_000, interval: 5 });
    await waitForIdle(queue);
    const done = board.kanbanList("done");
    expect(done).toHaveLength(1);
    expect(done[0]!.result_path).toBe(artifact);
    expect(board.kanbanList("failed")).toHaveLength(0);
  });
});
