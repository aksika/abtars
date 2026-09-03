import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ScheduledTaskRunner } from "./scheduled-task-runner.js";
import { settleRunOnce } from "./task-run-settler.js";
import { ProviderExecutionError } from "../transport/provider-failure.js";
import type { ContentOutcome } from "../clean-response.js";

vi.mock("./task-state-store.js", () => ({
  updateActiveRun: vi.fn(),
  advanceRun: vi.fn().mockReturnValue("advanced"),
  requestRunTerminal: vi.fn().mockReturnValue("requested"),
  readState: vi.fn(() => undefined),
  appendRun: vi.fn(),
  incrementDeferrals: vi.fn(() => 0),
  advanceNextRun: vi.fn(),
  readLastPromptAt: vi.fn(() => 0),
}));
vi.mock("./kanban-board.js", () => ({
  kanbanComplete: vi.fn(),
  kanbanFail: vi.fn(),
  kanbanAttachResult: vi.fn(),
  kanbanSetDeliveryReady: vi.fn(),
  kanbanEnqueue: vi.fn(() => 12345),
}));
vi.mock("./task-history-store.js", () => ({
  appendRunOnce: vi.fn(),
  hasRun: vi.fn(() => false),
}));
vi.mock("./task-run-settler.js", () => ({ settleRunOnce: vi.fn() }));
vi.mock("./task-preflight.js", () => ({ preflightTask: vi.fn(), validateReportArtifact: vi.fn() }));
vi.mock("../transport/bridge-lock-transport.js", () => ({ readLastPromptAt: vi.fn(() => 0) }));
vi.mock("../transport/tool-registry.js", () => ({ getToolDescriptor: vi.fn(() => undefined) }));
vi.mock("./task-log-ctx.js", () => ({ logTaskDebug: vi.fn(), logTaskTrace: vi.fn() }));

const { skillLaunch } = vi.hoisted(() => ({ skillLaunch: vi.fn() }));

const mockedSettle = vi.mocked(settleRunOnce);

vi.mock("../skill-session.js", () => ({
  skillSessionManager: { launch: (...args: unknown[]) => skillLaunch(...args) },
  listRunnableSkills: () => [],
}));

function makeEntry(id: string): any {
  return {
    id,
    kind: "agent",
    prompt: "run the task",
    agent: "task",
    interaction: { mode: "oneshot" },
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
    vi.clearAllMocks();
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
    let complete!: (value: { cardId: number; result: string; outcome: ContentOutcome }) => void;
    const startedPromise = new Promise<any>((resolve) => { started = resolve; });
    const resultPromise = new Promise<{ cardId: number; result: string; outcome: ContentOutcome }>((resolve) => { complete = resolve; });
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
    complete({ cardId: 43, result: "late", outcome: "text" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.mocked(settleRunOnce)).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    await vi.advanceTimersByTimeAsync(1);

    const outcome = await runPromise;
    expect(outcome.status).toBe("timed_out");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "timed_out", cardId: 43 }));
    expect(mockedSettle).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
  });

  it("#1539 accepts a child fact whose own time predates the deadline even when observed after it", async () => {
    const deadlineAt = Date.now() + 10_000;
    let started!: (control: any) => void;
    let complete!: (value: { cardId: number; result: string; outcome: "text"; factAt: number }) => void;
    const startedPromise = new Promise<any>((resolve) => { started = resolve; });
    const resultPromise = new Promise<{ cardId: number; result: string; outcome: "text"; factAt: number }>((resolve) => { complete = resolve; });
    const runner = new ScheduledTaskRunner({
      agentRunner: async (request) => {
        request.executionControl?.setCardId(44);
        started(request.executionControl);
        return resultPromise;
      },
    });
    const reservation = { ...makeReservation("runner-late-fact"), deadlineAt };
    const runPromise = runner.run(makeEntry("runner-late-fact"), reservation);
    const control = await startedPromise;
    await vi.advanceTimersByTimeAsync(10_000);
    // The fact occurred 5s BEFORE the deadline but is observed after it.
    complete({ cardId: 44, result: "pre-deadline result", outcome: "text", factAt: deadlineAt - 5000 });
    await vi.advanceTimersByTimeAsync(5_000);

    const outcome = await runPromise;
    // The pre-deadline fact is not discarded: the runner settles with the
    // child's own outcome and factAt; the settler decides the deadline race.
    expect(outcome.status).toBe("success");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "success",
      cardId: 44,
      factAt: deadlineAt - 5000,
    }));
    expect(mockedSettle).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "timed_out" }));
  });
});

describe("ScheduledTaskRunner #1516 orchestration dispatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes maxAgents=1 through the direct agent runner exactly once", async () => {
    const agentRunner = vi.fn(async (_request: import("../spin-types.js").SpinRequest) => ({ cardId: 7, result: "direct result", outcome: "text" as const }));
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
    expect(vi.mocked((await import("./kanban-board.js")).kanbanComplete)).not.toHaveBeenCalled();
  });

  it("fails closed when a single-agent runner omits the required outcome", async () => {
    // #1651 v2: AgentTaskRunner now requires `outcome`. This test pins the
    // documented defensive branch — a legacy runner that omits outcome is a
    // contract violation production must fail closed on (empty_model_response).
    // The mock's declared return satisfies the current type; the runtime shape
    // deliberately omits `outcome` to simulate that legacy caller.
    const agentRunner: (request: import("../spin-types.js").SpinRequest) => Promise<{ cardId: number; result: string; outcome: ContentOutcome }> =
      vi.fn(async () => ({ cardId: 9, result: "legacy result", outcome: undefined as never }));
    const projectRunner = vi.fn(async () => ({ cardId: 8, result: "project result" }));
    const runner = new ScheduledTaskRunner({ agentRunner, projectRunner });
    const legacy = makeEntry("dispatch-legacy");
    delete legacy.orchestration;
    const outcome = await runner.run(legacy, makeReservation("dispatch-legacy"));

    expect(outcome.status).toBe("failed");
    expect(agentRunner).toHaveBeenCalledTimes(1);
    expect(projectRunner).not.toHaveBeenCalled();
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      cardId: 9,
      diagnostic: expect.objectContaining({ code: "empty_model_response" }),
    }));
  });

  it("routes maxAgents>1 through the project runner exactly once, never the direct runner", async () => {
    const agentRunner = vi.fn(async (_request: import("../spin-types.js").SpinRequest) => ({ cardId: 7, result: "direct result", outcome: "text" as const }));
    const projectRunner = vi.fn(async (_request: import("./scheduled-project-runner.js").ScheduledProjectRequest) => ({ cardId: 8, result: "project synthesis" }));
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
    const projectRunner = vi.fn(async (_request: import("./scheduled-project-runner.js").ScheduledProjectRequest) => ({ cardId: 8, result: "synthesis" }));
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
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({ attachResult: true }));
  });
});

describe("ScheduledTaskRunner #1602 normalized-entry guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSettle.mockClear();
  });

  it("settles a raw agent entry with no interaction as definition_failed, with no dispatch", async () => {
    const agentRunner = vi.fn(async () => ({ cardId: 7, result: "must not run", outcome: "text" as const }));
    const projectRunner = vi.fn(async () => ({ cardId: 8, result: "must not run" }));
    const runner = new ScheduledTaskRunner({ agentRunner, projectRunner });
    const raw = makeEntry("raw-entry");
    delete raw.interaction;
    const outcome = await runner.run(raw, makeReservation("raw-entry"));

    expect(outcome.status).toBe("definition_failed");
    expect(outcome.safeDetail).toContain("unnormalized interaction");
    expect(agentRunner).not.toHaveBeenCalled();
    expect(projectRunner).not.toHaveBeenCalled();
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "definition_failed",
      diagnostic: expect.objectContaining({ category: "definition", code: "invalid_definition" }),
    }));
  });

  it("guards a null interaction object with the same classification", async () => {
    const agentRunner = vi.fn(async () => ({ cardId: 7, result: "must not run", outcome: "text" as const }));
    const runner = new ScheduledTaskRunner({ agentRunner });
    const raw = makeEntry("null-interaction");
    raw.interaction = null;
    const outcome = await runner.run(raw, makeReservation("null-interaction"));

    expect(outcome.status).toBe("definition_failed");
    expect(agentRunner).not.toHaveBeenCalled();
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "definition_failed",
      diagnostic: expect.objectContaining({ code: "invalid_definition" }),
    }));
  });

  it("settles an unsupported interaction discriminant as definition_failed without dispatch", async () => {
    const agentRunner = vi.fn(async () => ({ cardId: 7, result: "must not run", outcome: "text" as const }));
    const runner = new ScheduledTaskRunner({ agentRunner });
    const raw = makeEntry("bad-mode");
    raw.interaction = { mode: "weird" };
    const outcome = await runner.run(raw, makeReservation("bad-mode"));

    expect(outcome.status).toBe("definition_failed");
    expect(agentRunner).not.toHaveBeenCalled();
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "definition_failed" }));
  });

  it("keeps valid oneshot entries flowing through the direct runner", async () => {
    const agentRunner = vi.fn(async () => ({ cardId: 7, result: "direct result", outcome: "text" as const }));
    const runner = new ScheduledTaskRunner({ agentRunner });
    const outcome = await runner.run(makeEntry("valid-oneshot"), makeReservation("valid-oneshot"));
    expect(outcome.status).toBe("success");
    expect(agentRunner).toHaveBeenCalledTimes(1);
  });
});

describe("ScheduledTaskRunner #1432 scheduled skill launch", () => {
  beforeEach(() => {
    skillLaunch.mockReset();
    mockedSettle.mockClear();
    skillLaunch.mockResolvedValue({
      ok: true,
      kind: "launched",
      sessionId: "1_K_01",
      response: "Hola! Que quieres aprender hoy?",
      skillName: "spanish-tutor",
    });
  });

  it("launches K once, creates one announce card, settles once, and leaves K live", async () => {
    const entry = makeEntry("skill-launch");
    entry.interaction = {
      mode: "skill",
      skill: "spanish-tutor",
      target: { userId: "ada", platform: "telegram", chatId: "42" },
    };
    const runner = new ScheduledTaskRunner({ agentRunner: undefined, projectRunner: undefined });
    const outcome = await runner.run(entry, makeReservation("skill-launch"));

    expect(skillLaunch).toHaveBeenCalledTimes(1);
    expect(skillLaunch.mock.calls[0]![0]).toMatchObject({
      skill: "spanish-tutor",
      agent: "task",
      target: { userId: "ada", platform: "telegram", chatId: "42" },
    });
    expect(outcome.status).toBe("success");
    expect(mockedSettle).toHaveBeenCalledTimes(1);
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    // Later user turns belong to K — the run history is untouched by follow-ups.
    expect(mockedSettle).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("settles definition_failed when the skill launch rejects, with no card", async () => {
    skillLaunch.mockResolvedValue({ ok: false, error: { code: "not_found", message: "Skill \"nope\" not found" } });
    const entry = makeEntry("skill-missing");
    entry.interaction = { mode: "skill", skill: "nope", target: { userId: "ada", platform: "telegram", chatId: "42" } };
    const runner = new ScheduledTaskRunner({ agentRunner: undefined, projectRunner: undefined });
    const outcome = await runner.run(entry, makeReservation("skill-missing"));
    expect(outcome.status).toBe("definition_failed");
    expect(outcome.safeDetail).toContain("not found");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "definition_failed" }));
  });
});

describe("ScheduledTaskRunner #1610 announce delivery contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSettle.mockClear();
  });

  const LONG_RESULT = [
    "Good morning aksika!",
    "",
    "The day ahead looks clear and calm: no blocked projects are waiting on you, and all scheduled tasks finished cleanly overnight.",
    "",
    "Your main focus today is the steering consolidation work. Take it at your own pace.",
  ].join("\n");

  it("appends the delivery contract to one-shot announce dispatch prompts", async () => {
    const agentRunner = vi.fn(async (_request: import("../spin-types.js").SpinRequest) => ({ cardId: 7, result: "direct result", outcome: "text" as const }));
    const runner = new ScheduledTaskRunner({ agentRunner });
    const outcome = await runner.run(makeEntry("contract-announce"), makeReservation("contract-announce"));

    expect(outcome.status).toBe("success");
    const goal = agentRunner.mock.calls[0]![0].goal as string;
    expect(goal).toContain("[DELIVERY CONTRACT]");
    // #1724: the contract names Main as the announcer — the worker hands the
    // result over, cannot deliver it, and must not claim it announced.
    expect(goal).toContain("handed to Main");
    expect(goal).toContain("Do not call platform delivery tools");
    expect(goal).toContain("you must not claim that you announced or sent it");
    expect(goal).not.toContain("Telegram");
    expect(goal).not.toContain("DeepSeek");
  });

  it("leaves report dispatch prompts unchanged", async () => {
    const agentRunner = vi.fn(async (_request: import("../spin-types.js").SpinRequest) => ({ cardId: 7, result: "report result", outcome: "text" as const }));
    const runner = new ScheduledTaskRunner({ agentRunner });
    const entry = makeEntry("contract-report");
    entry.delivery = "report";
    entry.report = {
      artifact: "/tmp/daily.md",
      requiredSections: ["# Summary"],
      minBytes: 100,
      requires: { files: [], executables: [], tools: [] },
    };
    const preflightMod = await import("./task-preflight.js");
    vi.mocked(preflightMod.preflightTask).mockReturnValue({
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
    const outcome = await runner.run(entry, makeReservation("contract-report"));

    expect(outcome.status).toBe("success");
    const goal = agentRunner.mock.calls[0]![0].goal as string;
    expect(goal).not.toContain("[DELIVERY CONTRACT]");
  });

  it("leaves interactive skill launch messages unchanged", async () => {
    skillLaunch.mockResolvedValue({
      ok: true, kind: "launched", sessionId: "s", response: "Hola!", skillName: "spanish-tutor",
    });
    const entry = makeEntry("contract-skill");
    entry.interaction = { mode: "skill", skill: "spanish-tutor", target: { userId: "ada", platform: "telegram", chatId: "42" } };
    const runner = new ScheduledTaskRunner({ agentRunner: undefined, projectRunner: undefined });
    const outcome = await runner.run(entry, makeReservation("contract-skill"));

    expect(outcome.status).toBe("success");
    expect(skillLaunch.mock.calls[0]![0].message as string).not.toContain("[DELIVERY CONTRACT]");
  });

  it("passes the final response as deliveryText while detail stays a short prefix", async () => {
    const agentRunner = vi.fn(async () => ({ cardId: 7, result: LONG_RESULT, outcome: "text" as const }));
    const runner = new ScheduledTaskRunner({ agentRunner });
    const outcome = await runner.run(makeEntry("contract-long"), makeReservation("contract-long"));

    expect(outcome.status).toBe("success");
    expect(LONG_RESULT.length).toBeGreaterThan(200);
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "success",
      cardId: 7,
      deliveryText: LONG_RESULT,
      detail: LONG_RESULT.slice(0, 200),
    }));
    expect(outcome.safeDetail).toBe(LONG_RESULT.slice(0, 200));
  });

  it.each<[string, string]>([
    ["empty", ""],
    ["no_reply", "[NO_REPLY]"],
    ["reaction", "[REACT:👋]"],
  ])("#1651 v2: a %s announce turn settles failed with empty_model_response — never success, never delivery", async (_name, raw) => {
    const { classifyContent } = await import("../clean-response.js");
    const agentRunner = vi.fn(async () => ({ cardId: 7, result: raw, outcome: classifyContent(raw) }));
    const runner = new ScheduledTaskRunner({ agentRunner });
    const outcome = await runner.run(makeEntry(`announce-${_name}`), makeReservation(`announce-${_name}`));

    expect(outcome.status).toBe("failed");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      cardId: 7,
      diagnostic: expect.objectContaining({
        category: "execution",
        code: "empty_model_response",
        retryability: "none",
      }),
    }));
    const settleCall = mockedSettle.mock.calls[0]![0];
    expect(settleCall["deliveryText"]).toBeUndefined();
    expect(settleCall["releaseDelivery"]).not.toBe(true);
    expect(mockedSettle).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
  });

  it("#1651 v2: a text announce turn keeps success settlement and delivery", async () => {
    const agentRunner = vi.fn(async () => ({ cardId: 7, result: "morning briefing", outcome: "text" as const }));
    const runner = new ScheduledTaskRunner({ agentRunner });
    const outcome = await runner.run(makeEntry("announce-text"), makeReservation("announce-text"));

    expect(outcome.status).toBe("success");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "success",
      cardId: 7,
      deliveryText: "morning briefing",
      releaseDelivery: true,
    }));
  });

  it("#1651 v2: a report with a valid artifact succeeds even when the final prose is non-text", async () => {
    const agentRunner = vi.fn(async () => ({ cardId: 7, result: "[NO_REPLY]", outcome: "no_reply" as const }));
    const runner = new ScheduledTaskRunner({ agentRunner });
    const entry = makeEntry("report-artifact-wins");
    entry.delivery = "report";
    entry.report = {
      artifact: "/tmp/daily.md",
      requiredSections: ["# Summary"],
      minBytes: 100,
      requires: { files: [], executables: [], tools: [] },
    };
    const preflightMod = await import("./task-preflight.js");
    vi.mocked(preflightMod.preflightTask).mockReturnValue({
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
    const outcome = await runner.run(entry, makeReservation("report-artifact-wins"));

    expect(outcome.status).toBe("success");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", releaseDelivery: true }));
    expect(mockedSettle).not.toHaveBeenCalledWith(expect.objectContaining({ code: "empty_model_response" }));
  });

  it("#1651 v2: a report with an invalid artifact still fails — the text gate never rescues a bad artifact", async () => {
    const agentRunner = vi.fn(async () => ({ cardId: 7, result: "lots of useful prose", outcome: "text" as const }));
    const runner = new ScheduledTaskRunner({ agentRunner });
    const entry = makeEntry("report-artifact-fails");
    entry.delivery = "report";
    entry.report = {
      artifact: "/tmp/daily.md",
      requiredSections: ["# Summary"],
      minBytes: 100,
      requires: { files: [], executables: [], tools: [] },
    };
    const preflightMod = await import("./task-preflight.js");
    vi.mocked(preflightMod.preflightTask).mockReturnValue({
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
    vi.mocked(preflightMod.validateReportArtifact).mockReturnValue({ ok: false, code: "artifact_too_small", reason: "artifact is 12 bytes, minimum is 100" });
    const outcome = await runner.run(entry, makeReservation("report-artifact-fails"));

    expect(outcome.status).toBe("failed");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      diagnostic: expect.objectContaining({ category: "validation", code: "artifact_too_small" }),
    }));
  });
});

describe("ScheduledTaskRunner #1297 credits_exhausted mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSettle.mockClear();
  });

  it("maps ProviderExecutionError to execution/credits_exhausted with retryability none", async () => {
    const agentRunner = vi.fn(async () => {
      throw new ProviderExecutionError({
        code: "credits_exhausted",
        retryable: false,
        attemptedCandidates: 2,
        message: "All model candidates are blocked by provider credit exhaustion",
      });
    });
    const runner = new ScheduledTaskRunner({ agentRunner });
    const outcome = await runner.run(makeEntry("credits-runner"), makeReservation("credits-runner"));

    expect(outcome.status).toBe("failed");
    expect(outcome.safeDetail).toBe("All model candidates are blocked by provider credit exhaustion");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      diagnostic: expect.objectContaining({
        category: "execution",
        code: "credits_exhausted",
        retryability: "none",
      }),
    }));
  });

  it("never sets a retry timestamp or retry state for credits_exhausted", async () => {
    const agentRunner = vi.fn(async () => {
      throw new ProviderExecutionError({
        code: "credits_exhausted",
        retryable: false,
        attemptedCandidates: 1,
        message: "All model candidates are blocked by provider credit exhaustion",
      });
    });
    const runner = new ScheduledTaskRunner({ agentRunner });
    const outcome = await runner.run(makeEntry("credits-noretry"), makeReservation("credits-noretry"));

    expect(outcome.status).toBe("failed");
    const settleCall = mockedSettle.mock.calls[0]![0];
    expect(settleCall["retryAt"]).toBeUndefined();
    expect(settleCall.diagnostic?.retryability).toBe("none");
  });

  it("keeps generic mapping for ordinary model errors (no typed provider failure)", async () => {
    const agentRunner = vi.fn(async () => {
      throw new Error("generic provider outage");
    });
    const runner = new ScheduledTaskRunner({ agentRunner });
    const outcome = await runner.run(makeEntry("credits-generic"), makeReservation("credits-generic"));

    expect(outcome.status).toBe("failed");
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      diagnostic: expect.objectContaining({ code: "model_error" }),
    }));
  });
});
