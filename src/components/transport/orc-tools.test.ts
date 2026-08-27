/**
 * orc-tools.test.ts — Orc tool behavioral regression coverage (#1555, #1588,
 * #1591, #1604) plus the #1728 yield_turn boundary contract: context
 * requirement, pre-handoff rejection, one-shot latch win, and bounded repeat
 * behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getOrcTools, setOrcToolsDeps, clampBrowsingLaneDuration, MIN_BROWSING_LANE_MS } from "./orc-tools.js";
import type { OrcInvocationContextV2, OrcTurnControl, OrcTurnTerminal } from "../orc-project/orc-project-contracts.js";

const { spawnChildMock, getSupervisionMock, kanbanGetCardMock, validateWorkerRootCriteriaMock } = vi.hoisted(() => ({
  spawnChildMock: vi.fn().mockReturnValue(123),
  getSupervisionMock: vi.fn().mockReturnValue(undefined),
  kanbanGetCardMock: vi.fn().mockReturnValue({ max_tokens: null }),
  validateWorkerRootCriteriaMock: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../tasks/kanban-board.js", () => ({ kanbanGetCard: kanbanGetCardMock }));
vi.mock("../project-acceptance/project-review-store.js", () => ({
  ProjectReviewStore: class { getSupervision = getSupervisionMock; },
}));
vi.mock("../worker-supervision-service.js", () => ({
  validateWorkerRootCriteria: validateWorkerRootCriteriaMock,
  WorkerSupervisionService: class {},
}));

const spawnWorker = () => getOrcTools().find(tool => tool.name === "spawn_worker")!;
const orcContext = { userId: "test", orcContext: { projectCardId: 42 } } as any;

describe("spawn_worker missing session dependency (#1555)", () => {
  it("fails before any card or worker creation when not wired", async () => {
    const result = await spawnWorker().execute({
      goal: "Run the worker task",
      title: "unwired",
    }, orcContext);

    expect(result).toBe("[err] Orc tools not initialized");
    expect(spawnChildMock).not.toHaveBeenCalled();
    expect(kanbanGetCardMock).not.toHaveBeenCalled();
  });
});

describe("clampBrowsingLaneDuration (#1588)", () => {
  it("clamps a browsing lane with artifacts and a 2-minute budget up to the 300s floor", () => {
    expect(clampBrowsingLaneDuration("Browse three web pages and record results", "Lane 3", true, 120_000)).toBe(MIN_BROWSING_LANE_MS);
  });

  it("assigns the floor when a browsing lane declares artifacts but no duration", () => {
    expect(clampBrowsingLaneDuration("Fetch http://example.com and save", undefined, true, undefined)).toBe(MIN_BROWSING_LANE_MS);
  });

  it("leaves a browsing lane with a budget already above the floor untouched", () => {
    expect(clampBrowsingLaneDuration("Browse the web for data", "Web lane", true, 600_000)).toBe(600_000);
  });

  it("does not clamp lanes without artifacts or without browsing shape", () => {
    expect(clampBrowsingLaneDuration("Write a report", "Report lane", true, 120_000)).toBe(120_000);
    expect(clampBrowsingLaneDuration("Browse three pages", "Lane", false, 120_000)).toBe(120_000);
    expect(clampBrowsingLaneDuration("Compute results", "Lane", true, undefined)).toBeUndefined();
  });
});

describe("spawn_worker contract boundary (#1591)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnChildMock.mockReturnValue(123);
    getSupervisionMock.mockReturnValue(undefined);
    kanbanGetCardMock.mockReturnValue({ max_tokens: null });
    validateWorkerRootCriteriaMock.mockReturnValue(undefined);
    setOrcToolsDeps({ createSubSession: vi.fn(), getSessionById: vi.fn(), spawnChild: spawnChildMock });
  });

  it("keeps a duration-only spawn unsupervised while preserving timeoutMs", async () => {
    const result = await spawnWorker().execute({
      goal: "Run the worker task",
      title: "duration-only",
      max_duration_ms: "300000",
    }, orcContext);

    expect(result).toContain("+ Worker card #123 created");
    expect(spawnChildMock).toHaveBeenCalledWith(42, expect.objectContaining({
      contract: undefined,
      timeoutMs: 300000,
    }));
  });

  it.each([
    ["expected_artifacts", JSON.stringify([{ id: "a1" }])],
    ["verification_commands", "[]"],
    ["required_capabilities", JSON.stringify(["web"])],
    ["supports_root_criteria", JSON.stringify(["c1"])],
  ])("rejects %s without criteria before creating a card", async (field, value) => {
    const result = await spawnWorker().execute({ goal: "Needs supervision", [field]: value }, orcContext);

    expect(result).toContain("supervised spawn requires ≥1 criterion");
    expect(spawnChildMock).not.toHaveBeenCalled();
  });

  it("reports malformed criteria instead of silently falling back to unsupervised", async () => {
    const result = await spawnWorker().execute({ goal: "Needs supervision", criteria: "not-json" }, orcContext);

    expect(result).toContain("supervised spawn requires ≥1 criterion");
    expect(spawnChildMock).not.toHaveBeenCalled();
  });

  it("keeps max_tokens contract-bound when criteria are missing", async () => {
    const result = await spawnWorker().execute({ goal: "Needs a token budget", max_tokens: "5000" }, orcContext);

    expect(result).toContain("supervised spawn requires ≥1 criterion");
    expect(spawnChildMock).not.toHaveBeenCalled();
  });

  it("#1604 rejects criteria without supports_root_criteria and creates no card", async () => {
    validateWorkerRootCriteriaMock.mockReturnValue(
      "supports_root_criteria is required for supervised children of project #42; declare a JSON array of root criterion ids from: c1, c2, c3, c4, c5 (exact ids, case-sensitive)",
    );
    const result = await spawnWorker().execute({
      goal: "Lane 1 — feed research",
      criteria: JSON.stringify([{ id: "l1c1", description: "Run feed discovery" }]),
      max_duration_ms: "300000",
    }, orcContext);

    expect(result).toContain("[err]");
    expect(result).toContain("c1, c2, c3, c4, c5");
    expect(spawnChildMock).not.toHaveBeenCalled();
    expect(validateWorkerRootCriteriaMock).toHaveBeenCalledWith(42, "(pending)", []);
  });

  it("#1604 passes the declared mapping to the admission predicate", async () => {
    validateWorkerRootCriteriaMock.mockReturnValue(undefined);
    const result = await spawnWorker().execute({
      goal: "Lane 1 — feed research",
      criteria: JSON.stringify([{ id: "l1c1", description: "Run feed discovery" }]),
      supports_root_criteria: JSON.stringify(["c1"]),
      max_duration_ms: "300000",
    }, orcContext);

    expect(result).toContain("+ Worker card #123 created");
    expect(validateWorkerRootCriteriaMock).toHaveBeenCalledWith(42, "(pending)", ["c1"]);
    expect(spawnChildMock).toHaveBeenCalled();
  });

  it("does not advertise yield_turn outside project_execution", async () => {
    const result = await spawnWorker().execute({
      goal: "Review-only worker",
      criteria: JSON.stringify([{ id: "c1", description: "Review the evidence" }]),
      max_duration_ms: "300000",
    }, {
      ...orcContext,
      orcContext: { ...orcContext.orcContext, intentKind: "project_review" },
    });

    expect(result).toContain("[supervised]");
    expect(result).not.toContain("yield_turn");
  });
});

const EXEC_CONTEXT: OrcInvocationContextV2 = {
  version: 2,
  runId: "or_1",
  intentKey: "execute:1:1",
  intentKind: "project_execution",
  projectCardId: 1,
  projectGeneration: 1,
  ownershipGeneration: 1,
  ownerPeer: "kp",
  ownerInstanceId: "inst",
  origin: { kind: "local" },
};

function makeControl(satisfies: () => boolean): OrcTurnControl & { wins: number } {
  let completed: OrcTurnTerminal | null = null;
  const control = {
    runId: "or_1",
    get completed(): OrcTurnTerminal | null { return completed; },
    wins: 0,
    complete(terminal: OrcTurnTerminal): boolean {
      if (completed !== null) return false;
      if (!satisfies()) return false;
      completed = terminal;
      control.wins += 1;
      return true;
    },
  };
  return control as unknown as OrcTurnControl & { wins: number };
}

const tool = (): NonNullable<ReturnType<typeof findYield>> => findYield()!;
function findYield() {
  return getOrcTools().find(t => t.name === "yield_turn");
}

function ctx(control?: OrcTurnControl, intentKind = "project_execution"): never {
  return { orcContext: { ...EXEC_CONTEXT, intentKind }, orcTurnControl: control } as never;
}

describe("#1728 yield_turn", () => {
  it("exists on the Orc tool surface", () => {
    expect(findYield()).toBeDefined();
  });

  it("rejects without a bound project_execution context or host turn control", async () => {
    expect(await tool().execute({}, ctx(makeControl(() => true), "project_review"))).toContain("[err]");
    expect(await tool().execute({}, undefined as never)).toContain("[err]");
    expect(await tool().execute({}, { orcContext: { ...EXEC_CONTEXT, intentKind: "project_execution" } } as never)).toContain("[err]");
  });

  it("rejects a host turn control bound to a different run", async () => {
    const control = makeControl(() => true);
    const result = await tool().execute({}, {
      orcContext: { ...EXEC_CONTEXT, runId: "or_other" },
      orcTurnControl: control,
    } as never);

    expect(result).toContain("[err]");
    expect(result).toContain("does not match");
    expect(control.completed).toBeNull();
    expect(control.wins).toBe(0);
  });

  it("keeps the turn alive when the durable postcondition is unsatisfied", async () => {
    const control = makeControl(() => false);
    const result = await tool().execute({}, ctx(control));
    expect(result).toContain("[err]");
    expect(result).not.toContain("turn already completed");
    expect(control.completed).toBeNull();
    expect(control.wins).toBe(0);
  });

  it("wins the latch exactly once after the durable handoff; repeats are bounded errors", async () => {
    const control = makeControl(() => true);
    const ok = await tool().execute({}, ctx(control));
    expect(ok).toContain("✓");
    expect(control.wins).toBe(1);
    expect(control.completed).toMatchObject({ kind: "intent_satisfied", code: "project_execution_handed_off" });

    const repeat = await tool().execute({}, ctx(control));
    expect(repeat).toContain("[err] turn already completed");
    expect(control.wins).toBe(1);
    expect(control.completed).toMatchObject({ kind: "intent_satisfied", code: "project_execution_handed_off" });
  });
});
