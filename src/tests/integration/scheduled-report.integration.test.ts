import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("scheduled report acceptance (#1502 Task 12)", () => {
  let home: string;
  let board: typeof import("../../components/tasks/kanban-board.js");
  let deliverCard: typeof import("../../components/tasks/kanban-delivery.js").deliverCard;
  let CronQueue: typeof import("../../components/tasks/task-queue.js").CronQueue;

  beforeEach(async () => {
    vi.resetModules();
    home = join(tmpdir(), `abtars-scheduled-report-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
    board = await import("../../components/tasks/kanban-board.js");
    ({ deliverCard } = await import("../../components/tasks/kanban-delivery.js"));
    ({ CronQueue } = await import("../../components/tasks/task-queue.js"));
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
      return { cardId, result: `${canary} report line\n`.repeat(20) };
    });
    const queue = new CronQueue("unused", home, undefined, undefined, modelBoundary);
    queue.enqueue({
      id: "report-task", kind: "agent", prompt: `${canary} produce report`,
      agent: "task", delivery: "report", at: new Date().toISOString(),
      enabled: true, priority: "medium", chatId: "42",
    }, undefined, true);

    await waitForIdle(queue);
    expect(modelBoundary).toHaveBeenCalledOnce();
    const request = modelBoundary.mock.calls[0]![0];
    expect(request.executionScope?.cwd).toBe(join(home, "workspace", "report-task"));
    expect(request.executionScope?.env.WORKSPACE).toBe(request.executionScope.cwd);
    expect(process.env.WORKSPACE).toBeUndefined();

    const done = board.kanbanList("done");
    expect(done).toHaveLength(1);
    expect(done[0]!.result_path).toContain("report-task-");
    expect(existsSync(done[0]!.result_path!)).toBe(true);

    const deps = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
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
    const logPath = join(home, "logs", `bridge-${new Date().toISOString().slice(0, 10)}.log`);
    const logs = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    expect(logs).toContain("task_run_reserved");
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
    const queue = new CronQueue("unused", home, undefined, undefined, modelBoundary);
    queue.enqueue({
      id: "short-task", kind: "agent", prompt: "produce report",
      agent: "task", delivery: "report", at: new Date().toISOString(),
      enabled: true, priority: "medium",
    }, undefined, true);
    await waitForIdle(queue);

    const failed = board.kanbanList("failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.status).toBe("failed");
    // The delivery poll consumes done/pending cards only; a failed report has
    // no success delivery candidate and remains visibly failed for retry policy.
  });
});
