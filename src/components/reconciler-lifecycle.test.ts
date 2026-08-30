/**
 * reconciler-lifecycle.test.ts — #1554 Task 8 lifecycle regression portfolio.
 *
 * Real SQLite stores in a tmpdir; only external boundaries are scripted.
 * Covers: two-generation recovery/listener/source accounting, drain semantics,
 * lease-source registration identity, recovery truth, startup rollback, and
 * heartbeat decoupling (outbox independent, Reconciler tasks post-success).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectAcceptanceContractV1 } from "./project-acceptance/project-contract.js";

/** #1554 drain test: gate for ReviewCaseAssembler.assembleCase. */
let assemblyGate: Promise<unknown> | null = null;
let releaseAssembly: ((snapshot: unknown) => void) | null = null;

const dispatchMock = vi.fn();
vi.mock("../spin.js", () => ({
  spin: { dispatch: dispatchMock, spawnChild: vi.fn() },
}));

vi.mock("./project-acceptance/project-review-case.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-acceptance/project-review-case.js")>();
  return {
    ...actual,
    ReviewCaseAssembler: class extends actual.ReviewCaseAssembler {
      override async assembleCase(...args: unknown[]): Promise<unknown> {
        if (assemblyGate) return assemblyGate;
        return super.assembleCase(...(args as [number, number, number]));
      }
    },
  };
});

let TEST_HOME: string;
let kanban: typeof import("./kanban-board.js");
let reconciler: typeof import("./reconciler.js");
let workerStoreMod: typeof import("./worker-supervision-store.js");
let reviewStoreMod: typeof import("./project-acceptance/project-review-store.js");
let schedulerMod: typeof import("./lifecycle-wake-scheduler.js");
let quarantineMod: typeof import("./reconcile-quarantine-store.js");
let adapterMod: typeof import("./spin-worker-adapter.js");
let nerveBus: typeof import("./nerve.js")["nerve"];
let testCount = 0;

let activeHandle: import("./reconciler.js").ReconcilerHandle | null = null;
let scheduler: import("./lifecycle-wake-scheduler.js").LifecycleWakeScheduler | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  assemblyGate = null;
  releaseAssembly = null;
  vi.resetModules();
  TEST_HOME = mkdtempSync(join(tmpdir(), "reconciler-lifecycle-"));
  mkdirSync(join(TEST_HOME, "tasks"), { recursive: true });
  mkdirSync(join(TEST_HOME, "workspace"), { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME, abmindHome: () => join(TEST_HOME, "..", "abmind-test") }));
  kanban = await import("./tasks/kanban-board.js");
  reconciler = await import("./reconciler.js");
  workerStoreMod = await import("./worker-supervision-store.js");
  reviewStoreMod = await import("./project-acceptance/project-review-store.js");
  schedulerMod = await import("./lifecycle-wake-scheduler.js");
  quarantineMod = await import("./reconcile-quarantine-store.js");
  adapterMod = await import("./spin-worker-adapter.js");
  nerveBus = (await import("./nerve.js")).nerve;
});

afterEach(async () => {
  await activeHandle?.stop();
  activeHandle = null;
  scheduler?.stop();
  scheduler = null;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function flush(): Promise<void> {
  await new Promise(r => setTimeout(r, 10));
}

interface GenerationOverrides {
  coordinator?: unknown;
  piService?: unknown;
  createPiAdapter?: unknown;
  workerAdapter?: unknown;
  getQuarantineStore?: unknown;
  projectRunProgress?: unknown;
}

/** Start a fresh generation; stops any previous one. */
async function startGeneration(overrides: GenerationOverrides = {}): Promise<import("./reconciler.js").ReconcilerHandle> {
  await activeHandle?.stop();
  activeHandle = null;
  scheduler?.stop();
  scheduler = new schedulerMod.LifecycleWakeScheduler();
  const { OrcProjectRunStore } = await import("./orc-project/orc-project-run-store.js");
  activeHandle = await reconciler.startReconciler({
    generationId: `lifecycle-${++testCount}`,
    coordinator: (overrides.coordinator ?? {
      getStore: () => new OrcProjectRunStore(),
      bootRecovery: () => [] as number[],
      onOwnershipReleased: () => () => {},
      scheduleContractAuthoring: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      scheduleProjectExecution: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      scheduleReview: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
    }) as never,
    wakeScheduler: scheduler,
    workerAdapter: (overrides.workerAdapter ?? new adapterMod.SpinWorkerAdapter()) as never,
    piService: (overrides.piService ?? null) as never,
    createPiAdapter: (overrides.createPiAdapter ?? (() => ({
      kind: "pi",
      schedulingPolicy: { recovery: "inspectable" },
      capacity: async () => ({ available: 0, max: 0 }),
      start: async () => ({ kind: "start_failed", reason: "unavailable", retryable: false }),
      cancel: async () => ({ kind: "cancelled", attemptId: "" }),
      inspect: async () => ({ kind: "running", lifecycle: "running" }),
    }))) as never,
    getQuarantineStore: (overrides.getQuarantineStore ?? (() => new quarantineMod.ReconcileQuarantineStore())) as never,
    projectRunProgress: (overrides.projectRunProgress ?? (() => {})) as never,
  } as never);
  await scheduler.start();
  return activeHandle;
}

/** Live supervised root at card 1, generation 1 (the attempt's project lineage). */
function seedRootProject(): void {
  const rootId = kanban.kanbanEnqueue("recovery root", "agent", undefined, { type: "O", goal: "root" });
  kanban.kanbanRunning(rootId);
  const store = new reviewStoreMod.ProjectReviewStore();
  store.ensureAwaitingContract(rootId);
  store.insertContract({
    schema_version: 1,
    id: `ct_root_${rootId}`,
    digest: `d_${rootId}`,
    project_card_id: rootId,
    goal: "root",
    criteria: [{ id: "c1", description: "c", required: true, evidence_expectation: "synthesis" }],
    required_outputs: [],
    constraints: [],
    limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
    provenance: { requested_by: "scheduler", authored_by: "orc", created_at: new Date().toISOString() },
  } as never);
  store.stateTransition(rootId, ["awaiting_contract"], "executing");
}

/** Insert a supervised attempt row for a W child under a running project root. */
function seedActivePiAttempt(cardId: number): { cardId: number; attemptId: string } {
  const store = new workerStoreMod.WorkerSupervisionStore();
  const contractId = `ct_pi_${cardId}`;
  store.insertContract({
    schema_version: 1,
    id: contractId,
    digest: `d_${contractId}`,
    goal: "pi lane",
    criteria: [{ id: "c1", description: "c", required: true, evidence_expectation: "synthesis" }],
    expected_artifacts: [],
    verification_commands: [],
    required_capabilities: [],
    supports_root_criteria: ["c1"],
    limits: {},
    provenance: { root_card_id: 1, card_id: cardId, authored_by: "orc", created_at: new Date().toISOString() },
  } as never, cardId);
  store.insertAttempt({
    id: `a_pi_${cardId}`,
    card_id: cardId,
    contract_id: contractId,
    ordinal: 1,
    executor_kind: "pi",
    executor_id: "pi-coding",
    status: "running",
    started_at: new Date().toISOString(),
    root_project_card_id: 1,
    root_project_generation: 1,
    scheduled_run_id: null,
  } as never);
  return { cardId, attemptId: `a_pi_${cardId}` };
}

function attemptRowJson(attemptId: string): string {
  const store = new workerStoreMod.WorkerSupervisionStore();
  const row = store.db.prepare(`SELECT * FROM worker_attempts WHERE id = ?`).get(attemptId) as Record<string, unknown>;
  return JSON.stringify(row);
}

function nerveListenerCount(event: string): number {
  return nerveBus.listenerCount(event as never);
}

// ── Two generations ─────────────────────────────────────────────────────────

describe("two-generation lifecycle", () => {
  it("recovery runs once per generation, listener counts return to baseline, generation two accepts work", async () => {
    const baselineQueued = nerveListenerCount("card:queued");
    const baselineDone = nerveListenerCount("card:done");
    const baselineFailed = nerveListenerCount("card:failed");

    const h1 = await startGeneration();
    expect(h1.recovery.generationId).toBe("lifecycle-1");
    expect(h1.recovery.attempts).toEqual([]);
    expect(nerveListenerCount("card:queued")).toBe(baselineQueued + 1);
    expect(nerveListenerCount("card:done")).toBe(baselineDone + 1);
    expect(nerveListenerCount("card:failed")).toBe(baselineFailed + 1);
    expect(nerveBus.listenerCount("card:queued" as never) > baselineQueued).toBe(true);

    // generation two after stop: listeners removed, new listeners installed once
    const h2 = await startGeneration();
    expect(h2.recovery.generationId).toBe("lifecycle-2");
    expect(nerveListenerCount("card:queued")).toBe(baselineQueued + 1);
    expect(nerveListenerCount("card:done")).toBe(baselineDone + 1);
    expect(nerveListenerCount("card:failed")).toBe(baselineFailed + 1);

    // generation two accepts reconciliation work: a running root is woken
    // and the driver processes it (authoring supervision is created)
    const rootId = kanban.kanbanEnqueue("gen2 project", "agent", undefined, { type: "O", goal: "g" });
    kanban.kanbanRunning(rootId);
    reconciler.requestReconcile(rootId);
    await flush();
    await flush();
    const supervision = new reviewStoreMod.ProjectReviewStore().getSupervision(rootId);
    expect(supervision).toBeDefined();
    expect(supervision!.state).toBe("awaiting_contract");
  });

  it("a generation-one callback cannot mutate generation two, and out-of-order stop leaves the new hook intact", async () => {
    const h1 = await startGeneration();
    // a wake scheduled while generation one is live
    const rootId = kanban.kanbanEnqueue("old project", "agent", undefined, { type: "O", goal: "g" });
    kanban.kanbanRunning(rootId);
    dispatchMock.mockClear();
    reconciler.requestReconcile(rootId);
    // stop BEFORE the queued pass can run
    await h1.stop();
    activeHandle = null;
    scheduler?.stop();
    scheduler = null;

    const h2 = await startGeneration();
    await flush();
    // the generation-one wake must not have executed against generation two
    expect(dispatchMock).not.toHaveBeenCalled();

    // out-of-order stop of gen1 must not clear gen2's static lease hook
    const { ExecutorLeaseStore } = await import("./executor-lease-store.js");
    const hookAfterGen2 = ExecutorLeaseStore.onLeaseChanged;
    expect(hookAfterGen2).toBeDefined();
    await h1.stop(); // gen1 already stopped — idempotent
    expect(ExecutorLeaseStore.onLeaseChanged).toBe(hookAfterGen2);

    // generation two still accepts work
    reconciler.requestReconcile(rootId);
    await flush();
    await flush();
    expect(new reviewStoreMod.ProjectReviewStore().getSupervision(rootId)).toBeDefined();
  });
});

// ── Drain ───────────────────────────────────────────────────────────────────

describe("symmetric stop and drain", () => {
  function makeHoldAdapter(): { adapter: import("./swarm-executor-types.js").SwarmExecutorAdapter; release: (obs: unknown) => void; starts: number } {
    let release!: (obs: unknown) => void;
    const gate = new Promise<unknown>(resolve => { release = resolve; });
    const starts: number[] = [];
    return {
      starts,
      release: (obs: unknown) => release(obs),
      adapter: {
        kind: "agent",
        schedulingPolicy: { recovery: "process_bound" },
        capacity: async () => ({ available: 2, max: 2 }),
        start: async (claim) => {
          starts.push(claim.cardId);
          const observation = await gate;
          return observation as never;
        },
        cancel: async () => ({ kind: "cancelled", attemptId: "" }),
        inspect: async () => ({ kind: "running", lifecycle: "running" }),
      },
    };
  }

  it("stop waits for an active card pass and an active dispatch pass, then no queued continuation runs", async () => {
    const hold = makeHoldAdapter();
    const h = await startGeneration({ workerAdapter: hold.adapter as never });

    // dispatch-pass hold: a queued W child with a pending attempt under a
    // supervised live root (the claim path authorizes against it)
    const projectId = kanban.kanbanEnqueue("drain project", "agent", undefined, { type: "O", goal: "g" });
    kanban.kanbanRunning(projectId);
    const rootStore = new reviewStoreMod.ProjectReviewStore();
    rootStore.ensureAwaitingContract(projectId);
    rootStore.insertContract({
      schema_version: 1,
      id: `ct_drain_root`,
      digest: "d",
      project_card_id: projectId,
      goal: "g",
      criteria: [{ id: "c1", description: "c", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [],
      constraints: [],
      limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "scheduler", authored_by: "orc", created_at: new Date().toISOString() },
    } as never);
    rootStore.stateTransition(projectId, ["awaiting_contract"], "executing");
    const childId = kanban.kanbanEnqueue("drain child", "agent", undefined, {
      type: "W", parent_id: projectId, priority: "MEDIUM",
    });
    const supStore = new workerStoreMod.WorkerSupervisionStore();
    supStore.insertContract({
      schema_version: 1,
      id: "ct_drain",
      digest: "d",
      goal: "g",
      criteria: [{ id: "c1", description: "c", required: true, evidence_expectation: "synthesis" }],
      expected_artifacts: [],
      verification_commands: [],
      required_capabilities: [],
      supports_root_criteria: ["c1"],
      limits: {},
      provenance: { root_card_id: projectId, card_id: childId, authored_by: "orc", created_at: new Date().toISOString() },
    } as never, childId);
    supStore.insertAttempt({
      id: "a_drain",
      card_id: childId,
      contract_id: "ct_drain",
      ordinal: 1,
      executor_kind: "agent",
      executor_id: "spin-local",
      status: "pending",
      started_at: new Date().toISOString(),
      root_project_card_id: projectId,
      root_project_generation: 1,
      scheduled_run_id: null,
    } as never);

    reconciler.requestWorkerDispatch();
    await flush();
    expect(hold.starts.length).toBe(1); // the dispatch pass is inside adapter.start

    // card-pass hold: a second supervised executing root with all-terminal
    // children reaches createReviewCase, whose assembly is gated
    const gateCard = kanban.kanbanEnqueue("drain review project", "agent", undefined, { type: "O", goal: "g" });
    kanban.kanbanRunning(gateCard);
    const gateRootStore = new reviewStoreMod.ProjectReviewStore();
    gateRootStore.ensureAwaitingContract(gateCard);
    gateRootStore.insertContract({
      schema_version: 1,
      id: `ct_gate_root`,
      digest: "d",
      project_card_id: gateCard,
      goal: "g",
      criteria: [{ id: "c1", description: "c", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [],
      constraints: [],
      limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "scheduler", authored_by: "orc", created_at: new Date().toISOString() },
    } as never);
    gateRootStore.stateTransition(gateCard, ["awaiting_contract"], "executing");
    const gateChild = kanban.kanbanEnqueue("drain review child", "agent", undefined, {
      type: "W", parent_id: gateCard, priority: "MEDIUM",
    });
    const gateSupStore = new workerStoreMod.WorkerSupervisionStore();
    gateSupStore.insertContract({
      schema_version: 1,
      id: "ct_gate_child",
      digest: "d",
      goal: "g",
      criteria: [{ id: "c1", description: "c", required: true, evidence_expectation: "synthesis" }],
      expected_artifacts: [],
      verification_commands: [],
      required_capabilities: [],
      supports_root_criteria: ["c1"],
      limits: {},
      provenance: { root_card_id: gateCard, card_id: gateChild, authored_by: "orc", created_at: new Date().toISOString() },
    } as never, gateChild);
    gateSupStore.insertAttempt({
      id: "a_gate_child",
      card_id: gateChild,
      contract_id: "ct_gate_child",
      ordinal: 1,
      executor_kind: "agent",
      executor_id: "spin-local",
      status: "completed",
      started_at: new Date().toISOString(),
      root_project_card_id: gateCard,
      root_project_generation: 1,
      scheduled_run_id: null,
    } as never);
    kanban.kanbanComplete(gateChild, null, "gate child done");

    let releaseGate!: (snapshot: unknown) => void;
    assemblyGate = new Promise<unknown>(resolve => { releaseGate = resolve; });
    releaseAssembly = releaseGate;
    reconciler.requestReconcile(gateCard);
    await flush();
    await flush();

    const stopPromise = h.stop();
    let stopped = false;
    void stopPromise.then(() => { stopped = true; });
    await flush();
    await flush();
    // stop is waiting on the in-flight passes
    expect(stopped).toBe(false);

    // release the dispatch pass
    hold.release({ kind: "started", attemptId: "a_drain", generation: 1, executorId: "spin-local" });
    await flush();
    expect(stopped).toBe(false); // the card pass is still held

    releaseGate({ schema_version: 1, project_card_id: gateCard, generation: 1, round: 1, created_at: new Date().toISOString(), root_contract: { id: "c", digest: "d", goal: "g", criteria: [], required_outputs: [], limits: {} }, criterion_inputs: [], contradiction_candidates: [], uncovered_criteria: [], child_summaries: [], peer_contributions: [], budgets: { total_cost: 0, total_tokens: 0, wall_clock_ms: 1, review_round: 1, repair_round: 0 }, evidence_ref_count: 0, contradiction_count: 0 });
    await stopPromise;
    expect(stopped).toBe(true);

    // no queued continuation executes after stop
    const startsAfter = hold.starts.length;
    await flush();
    await flush();
    expect(hold.starts.length).toBe(startsAfter);
  });

  it("new wakes during closing/stopped are discarded", async () => {
    const h = await startGeneration();
    const rootId = kanban.kanbanEnqueue("discard project", "agent", undefined, { type: "O", goal: "g" });
    kanban.kanbanRunning(rootId);
    dispatchMock.mockClear();

    await h.stop();
    reconciler.requestReconcile(rootId);
    await flush();
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ── Lease source ────────────────────────────────────────────────────────────

describe("executor-lease source ownership", () => {
  it("registers exactly once per generation and unregisters on stop", async () => {
    const { ExecutorLeaseStore } = await import("./executor-lease-store.js");
    const registerSpy = vi.spyOn(schedulerMod.LifecycleWakeScheduler.prototype, "register");
    const h1 = await startGeneration();
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(ExecutorLeaseStore.onLeaseChanged).toBeDefined();

    await h1.stop();
    expect(ExecutorLeaseStore.onLeaseChanged).toBeUndefined();

    const h2 = await startGeneration();
    expect(registerSpy).toHaveBeenCalledTimes(2);
    expect(ExecutorLeaseStore.onLeaseChanged).toBeDefined();
    await h2.stop();
    expect(ExecutorLeaseStore.onLeaseChanged).toBeUndefined();
    registerSpy.mockRestore();
  });

  it("generation-one static hook cannot be cleared over generation two", async () => {
    const { ExecutorLeaseStore } = await import("./executor-lease-store.js");
    const h1 = await startGeneration();
    const hook1 = ExecutorLeaseStore.onLeaseChanged;
    const h2 = await startGeneration();
    const hook2 = ExecutorLeaseStore.onLeaseChanged;
    expect(hook1).not.toBe(hook2);
    // stopping generation one (already superseded) must not clear generation two's hook
    await h1.stop();
    expect(ExecutorLeaseStore.onLeaseChanged).toBe(hook2);
    await h2.stop();
    expect(ExecutorLeaseStore.onLeaseChanged).toBeUndefined();
  });
});

// ── Recovery truth ──────────────────────────────────────────────────────────

describe("exhaustive recovery accounting", () => {
  it("an unavailable Pi adapter leaves the attempt unresolved and durably unchanged", async () => {
    seedRootProject();
    const cardId = kanban.kanbanEnqueue("pi child", "agent", undefined, { type: "W", parent_id: 1 });
    const { attemptId } = seedActivePiAttempt(cardId);
    const before = attemptRowJson(attemptId);

    const h = await startGeneration({ piService: null });
    const entry = h.recovery.attempts.find(a => a.attemptId === attemptId);
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("unresolved");
    expect((entry! as { reason: string }).reason).toBe("executor_unavailable");
    expect(attemptRowJson(attemptId)).toBe(before); // byte-for-byte unchanged
  });

  it("Pi inspection is awaited: terminal observation settles, running stays active, throwing inspection is isolated", async () => {
    seedRootProject();
    const terminalCard = kanban.kanbanEnqueue("pi terminal", "agent", undefined, { type: "W", parent_id: 1 });
    const runningCard = kanban.kanbanEnqueue("pi running", "agent", undefined, { type: "W", parent_id: 1 });
    const throwCard = kanban.kanbanEnqueue("pi throw", "agent", undefined, { type: "W", parent_id: 1 });
    const t = seedActivePiAttempt(terminalCard);
    const r = seedActivePiAttempt(runningCard);
    const th = seedActivePiAttempt(throwCard);

    const store = new workerStoreMod.WorkerSupervisionStore();
    const fakeAdapter = {
      kind: "pi",
      schedulingPolicy: { recovery: "inspectable" },
      capacity: async () => ({ available: 1, max: 1 }),
      start: async () => ({ kind: "start_failed", reason: "unavailable", retryable: false }),
      cancel: async () => ({ kind: "cancelled", attemptId: "" }),
      inspect: async (claim: { attemptId: string }) => {
        if (claim.attemptId === t.attemptId) return { kind: "terminal", lifecycle: "completed" };
        if (claim.attemptId === r.attemptId) return { kind: "running", lifecycle: "running" };
        throw new Error("inspection boom");
      },
    };
    const h = await startGeneration({
      piService: { executor: { maxConcurrent: 1 }, store: null, config: null } as never,
      createPiAdapter: (() => fakeAdapter) as never,
    });

    const byId = new Map(h.recovery.attempts.map(a => [a.attemptId, a]));
    expect(byId.get(t.attemptId)!.kind).toBe("inspectable");
    expect((byId.get(t.attemptId)! as { observation: { kind: string } }).observation.kind).toBe("terminal");
    expect(byId.get(r.attemptId)!.kind).toBe("inspectable");
    expect((byId.get(r.attemptId)! as { observation: { kind: string } }).observation.kind).toBe("running");
    expect(byId.get(th.attemptId)!.kind).toBe("unresolved");
    expect((byId.get(th.attemptId)! as { reason: string }).reason).toBe("inspection_failed");

    // terminal observation settled the attempt through the generation-fenced store
    const terminalRow = store.db.prepare(`SELECT lifecycle FROM worker_attempts WHERE id = ?`).get(t.attemptId) as { lifecycle: string };
    expect(terminalRow.lifecycle).toBe("completed");
    // running observation left the attempt active
    const runningRow = store.db.prepare(`SELECT lifecycle FROM worker_attempts WHERE id = ?`).get(r.attemptId) as { lifecycle: string };
    expect(runningRow.lifecycle).toBe("running");
    // throwing inspection left the attempt active
    const throwRow = store.db.prepare(`SELECT lifecycle FROM worker_attempts WHERE id = ?`).get(th.attemptId) as { lifecycle: string };
    expect(throwRow.lifecycle).toBe("running");
  });

  it("process-bound attempts record their actual settlement outcome", async () => {
    seedRootProject();
    const cardId = kanban.kanbanEnqueue("agent child", "agent", undefined, { type: "W", parent_id: 1 });
    const store = new workerStoreMod.WorkerSupervisionStore();
    const contractId = "ct_agent";
    store.insertContract({
      schema_version: 1, id: contractId, digest: "d", goal: "g",
      criteria: [{ id: "c1", description: "c", required: true, evidence_expectation: "synthesis" }],
      expected_artifacts: [], verification_commands: [], required_capabilities: [], supports_root_criteria: ["c1"], limits: {},
      provenance: { root_card_id: 1, card_id: cardId, authored_by: "orc", created_at: new Date().toISOString() },
    } as never, cardId);
    store.insertAttempt({
      id: "a_agent_1", card_id: cardId, contract_id: contractId, ordinal: 1,
      executor_kind: "agent", executor_id: "spin-local", status: "running",
      started_at: new Date().toISOString(),
      root_project_card_id: 1, root_project_generation: 1, scheduled_run_id: null,
    } as never);

    const h = await startGeneration();
    const entry = h.recovery.attempts.find(a => a.attemptId === "a_agent_1");
    expect(entry!.kind).toBe("process_bound");
    expect((entry! as { outcome: string }).outcome).toBe("settled");
    const row = store.db.prepare(`SELECT lifecycle FROM worker_attempts WHERE id = ?`).get("a_agent_1") as { lifecycle: string };
    expect(row.lifecycle).toBe("timed_out");
  });
});

// ── Startup rollback ────────────────────────────────────────────────────────

describe("startup rollback", () => {
  it("a throwing coordinator boot recovery leaves no active slot, listener, source, or static hook", async () => {
    const baselineQueued = nerveListenerCount("card:queued");
    const { ExecutorLeaseStore } = await import("./executor-lease-store.js");
    const registerSpy = vi.spyOn(schedulerMod.LifecycleWakeScheduler.prototype, "register");

    await expect(startGeneration({
      coordinator: {
        bootRecovery: () => { throw new Error("coordinator boot recovery failed"); },
        onOwnershipReleased: () => () => {},
      } as never,
    })).rejects.toThrow("coordinator boot recovery failed");

    // no active generation remains
    expect(reconciler.getActiveOrcCoordinator()).toBeNull();
    // listeners were rolled back
    expect(nerveListenerCount("card:queued")).toBe(baselineQueued);
    // the static hook was cleared
    expect(ExecutorLeaseStore.onLeaseChanged).toBeUndefined();
    // no lease source remains registered on the (already stopped) scheduler
    expect(registerSpy).toHaveBeenCalledTimes(1);

    // a fresh start still works after the failed one
    const h = await startGeneration();
    expect(h.recovery.generationId).toBeDefined();
    await h.stop();
    registerSpy.mockRestore();
  });
});

// ── #1678 review-turn liveness ──────────────────────────────────────────────

describe("#1678 single owner of Orc review-turn liveness", () => {
  /** Seed a supervised root at generation 1 with an open review case + request. */
  function seedReviewRequest(attempts: number): { projectId: number; caseId: string; requestId: string } {
    const store = new reviewStoreMod.ProjectReviewStore();
    const projectId = kanban.kanbanEnqueue("review liveness", "agent", undefined, { type: "O", goal: "root" });
    kanban.kanbanRunning(projectId);
    store.ensureAwaitingContract(projectId);
    store.insertContract({
      schema_version: 1,
      id: `ct_live_${projectId}`,
      digest: `d_${projectId}`,
      project_card_id: projectId,
      goal: "root",
      criteria: [{ id: "c1", description: "c", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [],
      constraints: [],
      limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "scheduler", authored_by: "orc", created_at: new Date().toISOString() },
    } as never);
    store.stateTransition(projectId, ["awaiting_contract"], "executing");
    store.stateTransition(projectId, ["executing"], "review_ready");
    store.stateTransition(projectId, ["review_ready"], "review_requested");
    const { id: caseId } = store.insertReviewCase(projectId, 1, 1, { v: 1 }, "digest");
    const { id: requestId } = store.insertReviewRequest(projectId, caseId, 1);
    store.db.prepare("UPDATE project_review_requests SET attempts = ? WHERE id = ?").run(attempts, requestId);
    return { projectId, caseId, requestId };
  }

  it("a live review turn is never abandoned by elapsed retry ticks", async () => {
    const { OrcProjectRunStore } = await import("./orc-project/orc-project-run-store.js");
    const store = new reviewStoreMod.ProjectReviewStore();
    const { projectId, caseId, requestId } = seedReviewRequest(4);

    // Claim + bind a live project_review run at generation 1 through the real
    // run store — the turn is genuinely in flight.
    const runStore = new OrcProjectRunStore();
    const claim = runStore.claimIntent(
      { projectCardId: projectId, intentKind: "project_review", intentRef: caseId, goal: "review-live", originKind: "local", sourcePeer: null, cardSource: "agent", expectedProjectGeneration: 1 },
      "kp", "inst-live",
    );
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    runStore.promoteRun(claim.context.runId);
    const bound = runStore.bindExecution(claim.context, "sess-live", "exec-live");
    expect(bound.ok).toBe(true);

    // Start a generation whose coordinator claims through the same run store,
    // so a re-schedule of the live intent is observed as idempotent.
    const coordinator = {
      getStore: () => runStore,
      bootRecovery: () => [] as number[],
      onOwnershipReleased: () => () => {},
      scheduleContractAuthoring: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      scheduleProjectExecution: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      scheduleReview: (pid: number, gen: number, rc: string) => runStore.claimIntent(
        { projectCardId: pid, intentKind: "project_review", intentRef: rc, goal: "review-wake", originKind: "local", sourcePeer: null, cardSource: "agent", expectedProjectGeneration: gen },
        "kp", "inst-live",
      ),
    } as never;
    const h = await startGeneration({ coordinator });

    // Drive retry + abandon cycles well past maxAttempts (5). The 30s cooldown
    // is bypassed by resetting updated_at so every cycle re-selects the request.
    for (let i = 0; i < 4; i++) {
      reconciler.retryPendingReviewRequests();
      store.db.prepare("UPDATE project_review_requests SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), requestId);
      new reviewStoreMod.ProjectReviewStore().abandonExpiredRequests();
    }

    // Wake the project so any abandonment would visibly settle blocked.
    reconciler.requestReconcile(projectId);
    await flush();
    await flush();

    const req = store.db.prepare("SELECT status, attempts FROM project_review_requests WHERE id = ?").get(requestId) as { status: string; attempts: number } | undefined;
    expect(req).toBeDefined();
    expect(req!.status).toBe("pending");
    expect(req!.attempts).toBe(4); // observation ticks never advance the counter
    const supervision = store.getSupervision(projectId);
    expect(supervision).toBeDefined();
    expect(supervision!.state).toBe("review_requested");
    await h.stop();
  });

  it("genuine dispatch exhaustion still abandons and settles blocked", async () => {
    const store = new reviewStoreMod.ProjectReviewStore();
    const { projectId, requestId } = seedReviewRequest(0);

    // Every scheduleReview is rejected with a typed reason; no live run exists.
    const coordinator = {
      getStore: () => ({ db: store.db }) as never,
      bootRecovery: () => [] as number[],
      onOwnershipReleased: () => () => {},
      scheduleContractAuthoring: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      scheduleProjectExecution: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      scheduleReview: () => ({ kind: "conflict" as const, reason: "project_generation_mismatch" as const }),
    } as never;
    const h = await startGeneration({ coordinator });

    // Each retry records one REAL rejected dispatch. After maxAttempts the
    // safety valve fires: abandoned with the typed reason preserved.
    for (let i = 0; i < 8; i++) {
      reconciler.retryPendingReviewRequests();
      store.db.prepare("UPDATE project_review_requests SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), requestId);
      new reviewStoreMod.ProjectReviewStore().abandonExpiredRequests();
    }

    const req = store.db.prepare("SELECT status, attempts, last_error FROM project_review_requests WHERE id = ?").get(requestId) as { status: string; attempts: number; last_error: string } | undefined;
    expect(req!.status).toBe("abandoned");
    expect(req!.attempts).toBe(5);
    expect(req!.last_error).toContain("project_generation_mismatch");

    // A reconcile observes the abandoned request and settles blocked.
    reconciler.requestReconcile(projectId);
    await flush();
    await flush();
    const supervision = store.getSupervision(projectId);
    expect(supervision!.state).toBe("blocked");
    expect(supervision!.blocked_reason).toBe("review_request_abandoned");
    await h.stop();
  });

  it("an unavailable scheduled occurrence does not consume the review retry budget", async () => {
    const store = new reviewStoreMod.ProjectReviewStore();
    const { requestId } = seedReviewRequest(4);
    store.db.prepare("UPDATE project_review_requests SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), requestId);

    const coordinator = {
      getStore: () => ({ db: store.db }) as never,
      bootRecovery: () => [] as number[],
      onOwnershipReleased: () => () => {},
      scheduleContractAuthoring: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      scheduleProjectExecution: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      scheduleReview: () => ({ kind: "conflict" as const, reason: "occurrence_unavailable" as const }),
    } as never;
    const h = await startGeneration({ coordinator });

    expect(reconciler.retryPendingReviewRequests()).toBe(0);
    const req = store.db.prepare("SELECT status, attempts FROM project_review_requests WHERE id = ?").get(requestId) as { status: string; attempts: number } | undefined;
    expect(req).toEqual({ status: "pending", attempts: 4 });
    await h.stop();
  });

  it("observation ticks never advance the counter while the turn is live", async () => {
    const { OrcProjectRunStore } = await import("./orc-project/orc-project-run-store.js");
    const store = new reviewStoreMod.ProjectReviewStore();
    const { projectId, caseId, requestId } = seedReviewRequest(4);

    const runStore = new OrcProjectRunStore();
    const claim = runStore.claimIntent(
      { projectCardId: projectId, intentKind: "project_review", intentRef: caseId, goal: "review-live", originKind: "local", sourcePeer: null, cardSource: "agent", expectedProjectGeneration: 1 },
      "kp", "inst-live",
    );
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    runStore.promoteRun(claim.context.runId);
    const bound = runStore.bindExecution(claim.context, "sess-live", "exec-live");
    expect(bound.ok).toBe(true);

    const coordinator = {
      getStore: () => runStore,
      bootRecovery: () => [] as number[],
      onOwnershipReleased: () => () => {},
      scheduleContractAuthoring: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      scheduleProjectExecution: () => ({ kind: "busy" as const, activeRunId: "or_busy" }),
      scheduleReview: (pid: number, gen: number, rc: string) => runStore.claimIntent(
        { projectCardId: pid, intentKind: "project_review", intentRef: rc, goal: "review-wake", originKind: "local", sourcePeer: null, cardSource: "agent", expectedProjectGeneration: gen },
        "kp", "inst-live",
      ),
    } as never;
    const h = await startGeneration({ coordinator });

    for (let i = 0; i < 5; i++) {
      reconciler.retryPendingReviewRequests();
      store.db.prepare("UPDATE project_review_requests SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), requestId);
    }

    const req = store.db.prepare("SELECT status, attempts FROM project_review_requests WHERE id = ?").get(requestId) as { status: string; attempts: number } | undefined;
    expect(req!.status).toBe("pending");
    expect(req!.attempts).toBe(4);
    await h.stop();
  });

  it("a live turn's own settlement still terminates the request exactly once", async () => {
    const { OrcProjectRunStore } = await import("./orc-project/orc-project-run-store.js");
    const store = new reviewStoreMod.ProjectReviewStore();
    const { projectId, caseId, requestId } = seedReviewRequest(0);

    const runStore = new OrcProjectRunStore();
    const claim = runStore.claimIntent(
      { projectCardId: projectId, intentKind: "project_review", intentRef: caseId, goal: "review-live", originKind: "local", sourcePeer: null, cardSource: "agent", expectedProjectGeneration: 1 },
      "kp", "inst-live",
    );
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    runStore.promoteRun(claim.context.runId);
    const bound = runStore.bindExecution(claim.context, "sess-live", "exec-live");
    expect(bound.ok).toBe(true);

    // The bound review turn submits its decision — the case settles and the
    // request reaches its terminal status exactly once.
    store.settleAcceptance(projectId, caseId, { action: "accept", synthesis: "ok" }, "synthesis text");
    const req = store.db.prepare("SELECT status FROM project_review_requests WHERE id = ?").get(requestId) as { status: string };
    expect(req.status).toBe("settled");
    const caseRow = store.getReviewCase(caseId);
    expect(caseRow!.status).toBe("accepted");
    expect(store.getSupervision(projectId)!.state).toBe("accepted");
  });

  it("a stale abandoned request at an older generation is inert", async () => {
    const store = new reviewStoreMod.ProjectReviewStore();
    const projectId = kanban.kanbanEnqueue("stale abandoned", "agent", undefined, { type: "O", goal: "root" });
    kanban.kanbanRunning(projectId);
    store.ensureAwaitingContract(projectId);
    store.insertContract({
      schema_version: 1,
      id: `ct_stale_${projectId}`,
      digest: `d_${projectId}`,
      project_card_id: projectId,
      goal: "root",
      criteria: [{ id: "c1", description: "c", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [],
      constraints: [],
      limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "scheduler", authored_by: "orc", created_at: new Date().toISOString() },
    } as never);
    store.stateTransition(projectId, ["awaiting_contract"], "executing");
    store.stateTransition(projectId, ["executing"], "review_ready");
    store.stateTransition(projectId, ["review_ready"], "review_requested");
    // supervision has moved on to generation 2…
    store.db.prepare("UPDATE project_supervision SET generation = 2 WHERE project_card_id = ?").run(projectId);
    // …while a stale open case and its abandoned request still sit at gen 1
    const { id: caseId } = store.insertReviewCase(projectId, 1, 1, { v: 1 }, "digest");
    const { id: requestId } = store.insertReviewRequest(projectId, caseId, 1);
    store.db.prepare("UPDATE project_review_requests SET status = 'abandoned', attempts = 5, last_error = 'exceeded max attempts (last: none)' WHERE id = ?").run(requestId);

    const h = await startGeneration();
    reconciler.requestReconcile(projectId);
    await flush();
    await flush();

    // inert: no settleBlocked, no deep store assertion throw, and the current
    // generation's supervision is untouched
    const supervision = store.getSupervision(projectId);
    expect(supervision!.state).toBe("review_requested");
    expect(supervision!.generation).toBe(2);
    const caseRow = store.getReviewCase(caseId);
    expect(caseRow!.status).toBe("open");
    const req = store.db.prepare("SELECT status FROM project_review_requests WHERE id = ?").get(requestId) as { status: string };
    expect(req.status).toBe("abandoned");
    await h.stop();
  });
});

// ── Heartbeat decoupling ────────────────────────────────────────────────────

describe("heartbeat decoupling (#1554 approved move)", () => {
  function mockHeartbeat() {
    const tasks: Array<{ name: string }> = [];
    return {
      tasks,
      heartbeat: {
        registerTask: (task: { name: string }) => { tasks.push(task); },
      } as unknown as import("../components/heartbeat-system.js").HeartbeatSystem,
    };
  }

  it("project-acceptance-outbox registers in Tier-3 independent of Reconciler startup; Reconciler tasks only after success", async () => {
    const { heartbeat, tasks } = mockHeartbeat();
    mkdirSync(join(TEST_HOME, "config"), { recursive: true });
    writeFileSync(join(TEST_HOME, "config", "peers.json"), JSON.stringify({
      self: { name: "kp", signingKey: "k".repeat(64), tribeToken: "t".repeat(32) },
      peers: {},
    }));
    const scheduler = new schedulerMod.LifecycleWakeScheduler();
    const ctx = {
      heartbeat,
      lifecycleWakeScheduler: scheduler,
      reconcilerInputs: { projectRunProgress: () => {} },
      piExecutorService: undefined,
      phaseHealth: new Map(),
      transport: { healthCheck: null } as never,
      cronQueue: { pending: 0 } as never,
      pipelineDeps: { selfHealerTask: null } as never,
      config: { telegram: { allowedUserIds: [1] } } as never,
      memoryRuntime: {} as never,
      capabilities: { commands: [], heartbeatTasks: [] } as never,
      telegramAdapter: null,
    } as never;

    // Tier-3 registration alone: outbox present, Reconciler tasks absent
    const { registerTier3Tasks } = await import("../boot/heartbeat-tier3.js");
    await registerTier3Tasks(ctx as never);
    const names = tasks.map(t => t.name);
    expect(names).toContain("project-acceptance-outbox");
    expect(names).not.toContain("reconciler-resync");
    expect(names).not.toContain("review-request-retry");

    // phaseReconciler with a healthy environment registers the two tasks
    const phaseReconciler = await import("../boot/phase-reconciler.js");
    await phaseReconciler.phaseReconciler(ctx as never);
    const after = tasks.map(t => t.name);
    expect(after).toContain("reconciler-resync");
    expect(after).toContain("review-request-retry");
    // outbox still registered exactly once
    expect(after.filter(n => n === "project-acceptance-outbox")).toHaveLength(1);

    await (ctx as { reconcilerHandle: { stop(): Promise<void> } }).reconcilerHandle?.stop();
    scheduler.stop();
  });

  it("a Reconciler startup failure throws from phaseReconciler and registers no Reconciler task", async () => {
    const { heartbeat, tasks } = mockHeartbeat();
    const ctx = {
      heartbeat,
      lifecycleWakeScheduler: null,
      reconcilerInputs: null,
      phaseHealth: new Map(),
    } as never;

    const phaseReconciler = await import("../boot/phase-reconciler.js");
    await expect(phaseReconciler.phaseReconciler(ctx as never)).rejects.toThrow();
    expect(tasks.some(t => t.name === "reconciler-resync" || t.name === "review-request-retry")).toBe(false);
  });
});
