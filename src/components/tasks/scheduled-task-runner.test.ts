import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ScheduledTaskRunner } from "./scheduled-task-runner.js";
import { settleRunOnce } from "./task-run-settler.js";

vi.mock("./task-state-store.js", () => ({
  updateActiveRun: vi.fn(),
  appendRun: vi.fn(),
  incrementDeferrals: vi.fn(() => 0),
  advanceNextRun: vi.fn(),
  readLastPromptAt: vi.fn(() => 0),
}));
vi.mock("./kanban-board.js", () => ({
  kanbanComplete: vi.fn(),
  kanbanFail: vi.fn(),
  kanbanAttachResult: vi.fn(),
}));
vi.mock("./task-history-store.js", () => ({
  appendRunOnce: vi.fn(),
  hasRun: vi.fn(() => false),
}));
vi.mock("./task-run-settler.js", () => ({ settleRunOnce: vi.fn() }));
vi.mock("./task-preflight.js", () => ({ preflightTask: vi.fn(), validateReportArtifact: vi.fn() }));
vi.mock("../transport/bridge-lock-transport.js", () => ({ readLastPromptAt: vi.fn(() => 0) }));
vi.mock("../transport/pi-core-host.js", () => ({ getToolDescriptor: vi.fn(() => undefined) }));
vi.mock("./task-log-ctx.js", () => ({ logTaskDebug: vi.fn(), logTaskTrace: vi.fn() }));

const mockedSettle = vi.mocked(settleRunOnce);

function makeEntry(id: string): any {
  return {
    id,
    kind: "agent",
    prompt: "run the task",
    agent: "task",
    delivery: "announce",
    chatId: "1",
    schedule: "* * * * *",
    enabled: true,
    priority: "medium",
    orchestration: { maxAgents: 1 },
  };
}

function makeReservation(id: string): any {
  return {
    runId: `${id}-run`,
    groupId: `${id}-group`,
    attempt: 1,
    trigger: "manual",
    occurrenceAt: Date.now(),
    reservedAt: Date.now(),
    deadlineAt: Date.now() + 10_000,
    phase: "reserved",
    lastProgressAt: Date.now(),
  };
}

describe("ScheduledTaskRunner #1506 deadline ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedSettle.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles a timed-out caller-owned card with its ID and terminalizes control", async () => {
    let started!: (control: any) => void;
    const startedPromise = new Promise<any>((resolve) => { started = resolve; });
    const runner = new ScheduledTaskRunner({
      agentRunner: async (request) => {
        request.executionControl?.setCardId(42);
        started(request.executionControl);
        return await new Promise<never>(() => {});
      },
    });

    const runPromise = runner.run(makeEntry("runner-timeout"), makeReservation("runner-timeout"));
    const control = await startedPromise;
    expect(control.cardId).toBe(42);
    await vi.advanceTimersByTimeAsync(15_000);
    const outcome = await runPromise;

    expect(outcome.status).toBe("timed_out");
    expect(control.cancelled).toBe(true);
    expect(control.terminalOutcome).toBe("timed_out");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "timed_out",
      cardId: 42,
    }));
  });

  it("keeps a late completion from winning after the deadline", async () => {
    let started!: (control: any) => void;
    let complete!: (value: { cardId: number; result: string }) => void;
    const startedPromise = new Promise<any>((resolve) => { started = resolve; });
    const resultPromise = new Promise<{ cardId: number; result: string }>((resolve) => { complete = resolve; });
    const runner = new ScheduledTaskRunner({
      agentRunner: async (request) => {
        request.executionControl?.setCardId(43);
        started(request.executionControl);
        return resultPromise;
      },
    });

    const runPromise = runner.run(makeEntry("runner-race"), makeReservation("runner-race"));
    const control = await startedPromise;
    expect(control.cardId).toBe(43);
    await vi.advanceTimersByTimeAsync(10_000);
    complete({ cardId: 43, result: "late" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.mocked(settleRunOnce)).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    await vi.advanceTimersByTimeAsync(1);

    const outcome = await runPromise;
    expect(outcome.status).toBe("timed_out");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "timed_out", cardId: 43 }));
    expect(mockedSettle).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
  });
});

describe("ScheduledTaskRunner #1516 orchestration dispatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes maxAgents=1 through the direct agent runner exactly once", async () => {
    const agentRunner = vi.fn(async () => ({ cardId: 7, result: "direct result" }));
    const projectRunner = vi.fn(async () => ({ cardId: 8, result: "project result" }));
    const runner = new ScheduledTaskRunner({ agentRunner, projectRunner });
    const outcome = await runner.run(makeEntry("dispatch-direct"), makeReservation("dispatch-direct"));

    expect(agentRunner).toHaveBeenCalledTimes(1);
    expect(projectRunner).not.toHaveBeenCalled();
    expect(agentRunner.mock.calls[0]![0]).toMatchObject({
      type: "T",
      source: "task",
      settlementOwner: "caller",
      delivery: "announce",
    });
    expect(outcome.status).toBe("success");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", cardId: 7 }));
  });

  it("runs an old production-shaped task without orchestration through the direct runner exactly once", async () => {
    const agentRunner = vi.fn(async () => ({ cardId: 9, result: "legacy result" }));
    const projectRunner = vi.fn(async () => ({ cardId: 8, result: "project result" }));
    const runner = new ScheduledTaskRunner({ agentRunner, projectRunner });
    const legacy = makeEntry("dispatch-legacy");
    delete legacy.orchestration;
    const outcome = await runner.run(legacy, makeReservation("dispatch-legacy"));

    expect(outcome.status).toBe("success");
    expect(agentRunner).toHaveBeenCalledTimes(1);
    expect(projectRunner).not.toHaveBeenCalled();
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", cardId: 9 }));
  });

  it("routes maxAgents>1 through the project runner exactly once, never the direct runner", async () => {
    const agentRunner = vi.fn(async () => ({ cardId: 7, result: "direct result" }));
    const projectRunner = vi.fn(async () => ({ cardId: 8, result: "project synthesis" }));
    const runner = new ScheduledTaskRunner({ agentRunner, projectRunner });
    const entry = makeEntry("dispatch-project");
    entry.orchestration = { maxAgents: 4 };
    const outcome = await runner.run(entry, makeReservation("dispatch-project"));

    expect(projectRunner).toHaveBeenCalledTimes(1);
    expect(agentRunner).not.toHaveBeenCalled();
    const request = projectRunner.mock.calls[0]![0];
    expect(request).toMatchObject({
      entryId: "dispatch-project",
      runId: "dispatch-project-run",
      maxAgents: 4,
      priority: "medium",
      delivery: "announce",
      chatId: "1",
    });
    expect(request.executionControl).toBeDefined();
    expect(request.executionScope).toBeDefined();
    expect(request.deadlineAt).toBeGreaterThan(Date.now());
    expect(outcome.status).toBe("success");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", cardId: 8 }));
  });

  it("passes the resolved report artifact path to the project runner for report tasks", async () => {
    const projectRunner = vi.fn(async () => ({ cardId: 8, result: "synthesis" }));
    const runner = new ScheduledTaskRunner({ agentRunner: undefined, projectRunner });
    const entry = makeEntry("dispatch-report");
    entry.orchestration = { maxAgents: 2 };
    entry.delivery = "report";
    entry.report = {
      artifact: "/tmp/daily.md",
      requiredSections: ["# Summary"],
      minBytes: 100,
      requires: { files: [], executables: [], tools: [] },
    };
    const preflightMod = await import("./task-preflight.js");
    const preflight = vi.mocked(preflightMod.preflightTask);
    preflight.mockReturnValue({
      ok: true,
      report: {
        artifactPath: "/tmp/daily.md",
        artifactLabel: "/tmp/daily.md",
        requiredSections: ["# Summary"],
        minBytes: 100,
        requiredFiles: [],
        executables: [],
        tools: [],
      },
      artifactBaseline: { existed: false },
    });
    vi.mocked(preflightMod.validateReportArtifact).mockReturnValue({ ok: true, size: 1234 });
    const outcome = await runner.run(entry, makeReservation("dispatch-report"));
    expect(outcome.status).toBe("success");
    expect(projectRunner.mock.calls[0]![0].reportArtifactPath).toBe("/tmp/daily.md");
  });
});
