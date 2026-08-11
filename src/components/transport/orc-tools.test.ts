import { describe, it, expect, vi, beforeEach } from "vitest";

const { spawnChildMock, getSupervisionMock, kanbanGetCardMock, validateWorkerRootCriteriaMock } = vi.hoisted(() => ({
  spawnChildMock: vi.fn().mockReturnValue(123),
  getSupervisionMock: vi.fn().mockReturnValue(undefined),
  kanbanGetCardMock: vi.fn().mockReturnValue({ max_tokens: null }),
  validateWorkerRootCriteriaMock: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../spin.js", () => ({ spin: { spawnChild: spawnChildMock } }));
vi.mock("../tasks/kanban-board.js", () => ({ kanbanGetCard: kanbanGetCardMock }));
vi.mock("../project-acceptance/project-review-store.js", () => ({
  ProjectReviewStore: class { getSupervision = getSupervisionMock; },
}));
vi.mock("../worker-supervision-service.js", () => ({
  validateWorkerRootCriteria: validateWorkerRootCriteriaMock,
  WorkerSupervisionService: class {},
}));

import { clampBrowsingLaneDuration, MIN_BROWSING_LANE_MS, getOrcTools } from "./orc-tools.js";

const spawnWorker = () => getOrcTools().find(tool => tool.name === "spawn_worker")!;
const orcContext = { userId: "test", orcContext: { projectCardId: 42 } } as any;

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
});
