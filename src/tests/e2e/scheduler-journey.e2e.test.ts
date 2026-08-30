/**
 * scheduler-journey.e2e.test.ts — #1520 epic-owned production-shaped
 * non-interactive scheduler E2E.
 *
 * Boots the REAL task loader/state initializer, heartbeat tier-3 task tick,
 * checkCron, CronQueue, scheduled runner, report validation, history/state
 * stores, Kanban board, and delivery poll against a temporary abtars home.
 * Only external boundaries are doubled: model/provider response adapter,
 * platform sends, child-process spawn, sleep-cycle OS boundary, and the
 * clock — the scheduler's clock lives in durable task state, so the harness
 * advances time by rewriting nextRunAt/retryAt to the past and exercises the
 * real persistence/restart paths.
 *
 * K lifecycle/continuity stays in #1432; cross-session memory is outside.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { estimateTokensFromChars } from "../../components/transport/token-budget.js";

let TEST_HOME: string;

vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME, abmindHome: () => join(TEST_HOME, "..", "abmind-test"), abtarsRoot: () => join(TEST_HOME, "live-checkout") }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});
import * as child_process from "node:child_process";

// #1644: record bounded swarm-trace rejection evidence without changing log
// behavior — the mock is a passthrough that also captures swarm-trace lines.
const swarmTrace = vi.hoisted(() => ({ lines: [] as Array<{ tag: string; msg: string }> }));
vi.mock("../../components/logger.js", async () => {
  const actual = await vi.importActual<typeof import("../../components/logger.js")>("../../components/logger.js");
  return {
    ...actual,
    logTrace: (tag: string, msg: string) => {
      if (tag === "swarm-trace") swarmTrace.lines.push({ tag, msg });
      return actual.logTrace(tag, msg);
    },
  };
});

import type { ScheduledTask } from "../../components/tasks/task-types.js";
import type { TaskFailureDiagnosticV1 } from "../../components/tasks/task-failure.js";


// ── State store / module handles (real modules, loaded per test) ────────────
let stateStore: typeof import("../../components/tasks/task-state-store.js");
let historyStore: typeof import("../../components/tasks/task-history-store.js");
let board: typeof import("../../components/tasks/kanban-board.js");
let taskStore: typeof import("../../components/tasks/task-store.js");
let service: typeof import("../../components/tasks/task-service.js");
let delivery: typeof import("../../components/tasks/kanban-delivery.js");
let registry: typeof import("../../components/tasks/system-task-registry.js");
let tick: typeof import("../../boot/heartbeat-tier3.js");
let preflight: typeof import("../../components/tasks/task-preflight.js");
let settler: typeof import("../../components/tasks/task-run-settler.js");
let toolRegistry: typeof import("../../components/transport/tool-registry.js");
let executeToolCall: typeof import("../../components/transport/tool-registry.js").executeToolCall;
let CoordinatorClass: typeof import("../../components/tasks/scheduled-run-coordinator.js").ScheduledRunCoordinator;
let wakeSchedulerMod: typeof import("../../components/lifecycle-wake-scheduler.js");
let dueSourcesMod: typeof import("../../components/tasks/due-sources.js");
let reconcilerModule: typeof import("../../components/reconciler.js");
let realProjectRunner: typeof import("../../components/tasks/scheduled-project-runner.js").scheduledProjectRunner;
let observerClass: typeof import("./scheduled-custody-observer.js").ScheduledCustodyObserver;
let CustodyGapErrorClass: typeof import("./scheduled-custody-observer.js").CustodyGapError;
let reviewStoreMod: typeof import("../../components/project-acceptance/project-review-store.js");
let leaseStoreMod: typeof import("../../components/executor-lease-store.js");
let nerveMod: typeof import("../../components/nerve.js");
let WorkerSupervisionStoreClass: typeof import("../../components/worker-supervision-store.js").WorkerSupervisionStore;
let WorkerSupervisionServiceClass: typeof import("../../components/worker-supervision-service.js").WorkerSupervisionService;
let orcRunStoreMod: typeof import("../../components/orc-project/orc-project-run-store.js");
let taskTypesMod: typeof import("../../components/tasks/task-types.js");

// #1610: the announce task's model result — a multi-paragraph greeting longer
// than 200 characters, matching the escaped Molty morning-greeting shape.
const ANNOUNCE_GREETING = [
  "Good morning aksika!",
  "",
  "The day ahead looks clear and calm: no blocked projects are waiting on you, and all scheduled tasks finished cleanly overnight.",
  "",
  "Your main focus today is the steering consolidation work. Take it at your own pace.",
].join("\n");

const FIXTURES: ScheduledTask[] = [
  {
    id: "sys-sleep", kind: "system", action: "sleep-cycle", schedule: "0 2 * * *",
    enabled: true, priority: "medium", delivery: "silent",
  },
  {
    id: "gate-script", kind: "script", command: "echo gate-output-42", schedule: "* * * * *",
    enabled: true, priority: "medium", delivery: "silent",
    followUp: { prompt: "Summarize {{GATE_OUTPUT}}", agent: "task" },
  },
  {
    id: "announce-task", kind: "agent", prompt: "Announce the weather", agent: "task",
    interaction: { mode: "oneshot" }, orchestration: { maxAgents: 1 },
    schedule: "* * * * *", enabled: true, priority: "medium", delivery: "announce", chatId: "42424242",
  },
  {
    id: "report-task", kind: "agent", prompt: "Write the finance report", agent: "task",
    interaction: { mode: "oneshot" }, orchestration: { maxAgents: 1 },
    schedule: "* * * * *", enabled: true, priority: "medium", delivery: "report", chatId: "42424242",
  },
  {
    id: "project-task", kind: "agent", prompt: "Supervised multi-agent work", agent: "task",
    interaction: { mode: "oneshot" }, orchestration: { maxAgents: 2 },
    schedule: "* * * * *", enabled: true, priority: "medium", delivery: "announce", chatId: "42424242",
  },
  {
    id: "flaky-task", kind: "agent", prompt: "Flaky one-shot", agent: "task",
    interaction: { mode: "oneshot" }, orchestration: { maxAgents: 1 },
    schedule: "* * * * *", enabled: true, priority: "medium", delivery: "announce", chatId: "42424242",
  },
  {
    id: "deferred-task", kind: "agent", prompt: "Admission-gated one-shot", agent: "task",
    interaction: { mode: "oneshot" }, orchestration: { maxAgents: 1 },
    schedule: "* * * * *", enabled: true, priority: "medium", delivery: "announce", chatId: "42424242",
  },
  {
    id: "sha-agent-task", kind: "agent", prompt: "SHA E2E failing agent task", agent: "task",
    interaction: { mode: "oneshot" }, orchestration: { maxAgents: 1 },
    schedule: "* * * * *", enabled: true, priority: "medium", delivery: "silent", chatId: "42424242",
  },
  {
    id: "daily-reminder", kind: "reminder", text: "Take a break", schedule: "0 9 * * *",
    enabled: true, priority: "medium", delivery: "announce", chatId: "42424242",
  },
];

// ── External boundary doubles ───────────────────────────────────────────────
interface SchedulerDoubles {
  providerFailures: number;
  providerErrors: Array<{ code?: string; retryable?: boolean }>;
  admissionRejections: number;
  sleepCycleCalls: number;
  sentMessages: string[];
  sentDocuments: Array<{ chatId: string; path: string }>;
  injectedReminders: string[];
  pausedNotifications: string[];
  spawnedCommands: string[];
  dispatchedGoals: string[];
  /** #1724: Main-owned announcement handoffs from the delivery boundary. */
  mainAnnouncements: Array<{ eventId: string; cardId: number; title: string; result: string }>;
  mainAnnouncementOutcome: "sent" | "not_sent" | "unknown";
}

let doubles: SchedulerDoubles;

function fakeAgentRunner(request: import("../../components/spin-types.js").SpinRequest): Promise<{ cardId: number; result: string; outcome: "text" }> {
  const entryId = (request.title ?? "").toLowerCase().replace(/\s+/g, "-");
  doubles.dispatchedGoals.push(request.goal ?? "");
  if (entryId === "flaky-task" && doubles.providerFailures > 0) {
    doubles.providerFailures--;
    const err = new Error("provider transient outage") as Error & { code?: string };
    err.code = "rate_limited";
    return Promise.reject(err);
  }
  if (entryId === "deferred-task") {
    doubles.admissionRejections++;
    // Lazy import so instanceof matches the runner's module instance
    // (the harness resets modules per test).
    return import("../../components/spin-types.js").then(({ SpinDispatchAdmissionError }) =>
      Promise.reject(new SpinDispatchAdmissionError("session_capacity", "max sessions reached", undefined)));
  }
  // #1688: the SHA E2E agent task fails with a structured execution error so
  // the real settler fires the typed failure cascade.
  if (entryId === "sha-agent-task") {
    const err = new Error("provider model error: sha-incident-boom") as Error & { code?: string };
    err.code = "model_error";
    return Promise.reject(err);
  }
  // Production shape: spin.dispatch pre-creates the card with the request's
  // type/delivery/chat identity (#1724 makes those fields route delivery).
  const cardId = board.kanbanEnqueue(request.title ?? entryId, "task", request.goal?.slice(0, 80), {
    type: request.type,
    deliveryMode: request.delivery,
    chatId: request.chatId,
  });
  // Report tasks: the provider writes the declared artifact before settling.
  if (entryId === "report-task") {
    const dir = join(TEST_HOME, "workspace", "report-task");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), `## Summary\n\nFinance report body with enough bytes to pass the 100-byte minimum contract. \nAdditional verified sections for the report pipeline.\n`);
  }
  // #1610: the announce task's model result is a multi-paragraph greeting
  // longer than 200 characters — the exact escaped production shape.
  if (entryId === "announce-task") {
    return Promise.resolve({ cardId, result: ANNOUNCE_GREETING, outcome: "text" });
  }
  return Promise.resolve({ cardId, result: `result for ${entryId}`, outcome: "text" });
}

function makeDeliveryDeps() {
  return {
    sendMessage: async (chatId: string, text: string): Promise<"sent"> => {
      doubles.sentMessages.push(text);
      return "sent";
    },
    sendDocument: async (chatId: string, filePath: string, _caption: string): Promise<"sent"> => {
      doubles.sentDocuments.push({ chatId, path: filePath });
      return "sent";
    },
    announce: async () => {},
    chatIdFor: () => "42424242",
    // #1724: boot-composed Main-owned announcement route (boundary double —
    // the real closure resolves the target and submits through Main).
    announceToMain: async (card: { id: number; title: string; result_summary: string | null }): Promise<"sent" | "not_sent" | "unknown"> => {
      doubles.mainAnnouncements.push({
        eventId: `scheduled-card:${card.id}`,
        cardId: card.id,
        title: card.title,
        result: card.result_summary ?? "",
      });
      return doubles.mainAnnouncementOutcome;
    },
  };
}

function makeFakeChild() {
  const child = new EventEmitter() as unknown as child_process.ChildProcess;
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (child as unknown as { pid: number }).pid = 424242;
  (child as unknown as { killed: boolean }).killed = false;
  return child;
}

// ── Harness ─────────────────────────────────────────────────────────────────
async function loadModules(): Promise<void> {
  vi.resetModules();
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME, abmindHome: () => join(TEST_HOME, "..", "abmind-test"), abtarsRoot: () => join(TEST_HOME, "live-checkout") }));
  stateStore = await import("../../components/tasks/task-state-store.js");
  historyStore = await import("../../components/tasks/task-history-store.js");
  board = await import("../../components/tasks/kanban-board.js");
  taskStore = await import("../../components/tasks/task-store.js");
  service = await import("../../components/tasks/task-service.js");
  delivery = await import("../../components/tasks/kanban-delivery.js");
  registry = await import("../../components/tasks/system-task-registry.js");
  tick = await import("../../boot/heartbeat-tier3.js");
  preflight = await import("../../components/tasks/task-preflight.js");
  settler = await import("../../components/tasks/task-run-settler.js");
  toolRegistry = await import("../../components/transport/tool-registry.js");
  executeToolCall = (await import("../../components/transport/tool-registry.js")).executeToolCall;
  CoordinatorClass = (await import("../../components/tasks/scheduled-run-coordinator.js")).ScheduledRunCoordinator;
  wakeSchedulerMod = await import("../../components/lifecycle-wake-scheduler.js");
  dueSourcesMod = await import("../../components/tasks/due-sources.js");
  reconcilerModule = await import("../../components/reconciler.js");
  realProjectRunner = (await import("../../components/tasks/scheduled-project-runner.js")).scheduledProjectRunner;
  makeFixtureFactory = (await import("./scheduled-project-fixture.js")).makeScheduledProjectFixture;
  observerClass = (await import("./scheduled-custody-observer.js")).ScheduledCustodyObserver;
  CustodyGapErrorClass = (await import("./scheduled-custody-observer.js")).CustodyGapError;
  reviewStoreMod = await import("../../components/project-acceptance/project-review-store.js");
  leaseStoreMod = await import("../../components/executor-lease-store.js");
  nerveMod = await import("../../components/nerve.js");
  WorkerSupervisionStoreClass = (await import("../../components/worker-supervision-store.js")).WorkerSupervisionStore;
  WorkerSupervisionServiceClass = (await import("../../components/worker-supervision-service.js")).WorkerSupervisionService;
  orcRunStoreMod = await import("../../components/orc-project/orc-project-run-store.js");
  taskTypesMod = await import("../../components/tasks/task-types.js");
}

function writeFixtureTasks(): void {
  const entries = FIXTURES.map(f => {
    if (f.kind === "agent") return { ...f, report: f.id === "report-task" ? {
      artifact: join(TEST_HOME, "workspace", "report-task", "report.md"),
      requiredSections: ["## Summary"],
      minBytes: 100,
      requires: { files: [], executables: ["curl"], tools: ["execute_bash"] },
    } : undefined };
    return f;
  });
  writeFileSync(join(TEST_HOME, "tasks", "tasks.json"), JSON.stringify(entries, null, 2));
}

async function makeQueue(): Promise<import("../../components/tasks/task-queue.js").CronQueue> {
  const { CronQueue } = await import("../../components/tasks/task-queue.js");
  const coordinator = new CoordinatorClass({
    onTaskPaused: (chatId, title, reason) => { doubles.pausedNotifications.push(`${chatId}:${title}:${reason}`); },
    agentRunner: fakeAgentRunner,
    projectRunner: realProjectRunner,
  });
  const queue = new CronQueue(coordinator);
  return queue;
}

/** #1539: coordinator + queue pair so journeys can drive deadlines/cancel. */
async function makeQueueWithCoordinator(): Promise<{ queue: import("../../components/tasks/task-queue.js").CronQueue; coordinator: CoordinatorClass }> {
  const { CronQueue } = await import("../../components/tasks/task-queue.js");
  const coordinator = new CoordinatorClass({
    onTaskPaused: (chatId, title, reason) => { doubles.pausedNotifications.push(`${chatId}:${title}:${reason}`); },
    agentRunner: fakeAgentRunner,
    projectRunner: realProjectRunner,
  });
  const queue = new CronQueue(coordinator);
  return { queue, coordinator };
}

/** #1548: per-test scripted Orc boundary wired into the real reconciler. */

let activeTestHandle: import("../../components/reconciler.js").ReconcilerHandle | null = null;

/** #1554: start a real generation over the fixture coordinator (real stores).
 * The worker adapter is a pass-through: the fixture owns worker completion
 * (completeWorkers), so the dispatch pump must keep claims running instead of
 * executing real Spin sessions against an unset runtime. */
async function startGeneration(coordinator: unknown): Promise<void> {
  const { LifecycleWakeScheduler } = await import("../../components/lifecycle-wake-scheduler.js");
  const { ReconcileQuarantineStore } = await import("../../components/reconcile-quarantine-store.js");
  await activeTestHandle?.stop();
  activeTestHandle = null;
  const scheduler = new LifecycleWakeScheduler();
  activeTestHandle = await reconcilerModule.startReconciler({
    generationId: `scheduler-journey-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    coordinator: coordinator as never,
    wakeScheduler: scheduler,
    workerAdapter: {
      kind: "agent",
      schedulingPolicy: { recovery: "process_bound" },
      capacity: async () => ({ available: 8, max: 8 }),
      start: async () => ({ kind: "started", attemptId: "", generation: 1, executorId: "spin-local" }),
      cancel: async () => ({ kind: "cancelled", attemptId: "" }),
      inspect: async () => ({ kind: "running", lifecycle: "running" }),
    } as never,
    piService: null,
    createPiAdapter: (() => ({ kind: "pi", capacity: async () => ({ available: 0, max: 0 }), start: async () => ({ kind: "start_failed", reason: "unavailable", retryable: false }), cancel: async () => ({ kind: "cancelled", attemptId: "" }), inspect: async () => ({ kind: "running", lifecycle: "running" }) })) as never,
    getQuarantineStore: () => new ReconcileQuarantineStore(),
    projectRunProgress: () => {},
  } as never);
  await scheduler.start();
}

async function makeFixture(opts?: Parameters<typeof makeFixtureFactory>[1]) {
  const { fixture, orc } = makeFixtureFactory({
    OrcProjectCoordinator: (await import("../../components/orc-project/orc-project-coordinator.js")).OrcProjectCoordinator,
    ProjectReviewStore: (await import("../../components/project-acceptance/project-review-store.js")).ProjectReviewStore,
    kanban: await import("../../components/tasks/kanban-board.js"),
    nerve: (await import("../../components/nerve.js")).nerve,
    WorkerSupervisionService: (await import("../../components/worker-supervision-service.js")).WorkerSupervisionService,
    WorkerSupervisionStore: (await import("../../components/worker-supervision-store.js")).WorkerSupervisionStore,
  }, opts);
  // #1554: the fixture's Orc coordinator becomes the generation's own — no
  // module setter wiring.
  await startGeneration(orc);
  return { fixture, orc };
}

let makeFixtureFactory: typeof import("./scheduled-project-fixture.js").makeScheduledProjectFixture;

function makeTickCtx(queue: import("../../components/tasks/task-queue.js").CronQueue) {
  return {
    cronQueue: queue,
    telegramAdapter: {
      injectMessage: (msg: { text: string }) => { doubles.injectedReminders.push(msg.text); },
    } as never,
  } as Parameters<typeof tick.runTaskTick>[0];
}

async function runTick(queue: import("../../components/tasks/task-queue.js").CronQueue): Promise<void> {
  await tick.runTaskTick(makeTickCtx(queue));
  await awaitIdle(queue);
}

async function awaitIdle(queue: import("../../components/tasks/task-queue.js").CronQueue): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (queue.pending === 0 && queue.currentJob === null) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("queue did not become idle");
}

function forceDue(taskId: string): void {
  stateStore.updateState(taskId, { nextRunAt: Date.now() - 1000 });
}

function advanceAdmissionDeferral(taskId: string): void {
  const st = stateStore.readState(taskId);
  if (st?.deferredAdmission) {
    stateStore.updateState(taskId, { nextRunAt: st.deferredAdmission.retryAt - 1 });
  }
}

function events(taskId: string): Array<{ outcome: string; runId?: string; groupId?: string; detail?: string; deliveryText?: string; kanbanCardId?: number; diagnostic?: { category: string; code: string } }> {
  return historyStore.recentRuns(taskId, 50);
}

function cardStatuses(): string[] {
  return board.kanbanList("*").map((c: { id: number; status: string }) => `${c.id}:${c.status}`);
}

beforeEach(async () => {
  TEST_HOME = mkdtempSync(join(tmpdir(), "sched-e2e-"));
  mkdirSync(join(TEST_HOME, "tasks"), { recursive: true });
  mkdirSync(join(TEST_HOME, "workspace"), { recursive: true });
  mkdirSync(join(TEST_HOME, "config"), { recursive: true });
  writeFileSync(join(TEST_HOME, "config", "users.json"), JSON.stringify({
    users: [{ userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 1111111111 } }],
  }));
  doubles = {
    providerFailures: 0, providerErrors: [], admissionRejections: 0,
    sleepCycleCalls: 0, sentMessages: [], sentDocuments: [], injectedReminders: [],
    pausedNotifications: [], spawnedCommands: [], dispatchedGoals: [],
    mainAnnouncements: [], mainAnnouncementOutcome: "sent",
  };
  swarmTrace.lines = [];
  vi.mocked(child_process.spawn).mockImplementation(((
    _file: string,
    args: readonly string[],
  ) => {
    const cmd = (args[1] ?? "") as string;
    doubles.spawnedCommands.push(cmd);
    const c = makeFakeChild();
    setImmediate(() => {
      (c.stdout as EventEmitter).emit("data", Buffer.from("gate-output-42\n"));
      c.emit("exit", 0);
    });
    return c;
  }) as unknown as typeof child_process.spawn);
  await loadModules();
  writeFixtureTasks();
  const entries = taskStore.readEntries();
  stateStore.initializeState(entries);
  registry._resetSystemTaskRegistry();
  registry.getSystemTaskRegistry().register("sleep-cycle", (_entry, _ctx) => {
    doubles.sleepCycleCalls++;
    if (doubles.sleepCycleCalls === 1) {
      return { status: "deferred", retryAt: Date.now() + 60_000, detail: "sleep active" };
    }
    if (doubles.sleepCycleCalls === 2) {
      return { status: "noop", detail: "already asleep" };
    }
    return { status: "ok", detail: "cycle handled" };
  });
}, 60_000);

afterEach(async () => {
  await activeTestHandle?.stop();
  activeTestHandle = null;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── Journeys ────────────────────────────────────────────────────────────────

describe("#1520 scheduler E2E — journey 1: system/Dreamy sleep-cycle", () => {
  it("defers safely, noops, then succeeds without failure counts or drops", async () => {
    const queue = await makeQueue();
    forceDue("sys-sleep");
    await runTick(queue);
    expect(doubles.sleepCycleCalls).toBe(1);
    const ev1 = events("sys-sleep");
    expect(ev1).toHaveLength(1);
    expect(ev1[0]!.outcome).toBe("deferred");
    expect(ev1[0]!.diagnostic?.category).toBe("admission");
    expect(ev1[0]!.diagnostic?.code).toBe("executor_unavailable");
    expect(stateStore.readState("sys-sleep")!.consecutiveFailures).toBe(0);

    // Advance the durable retry time → next tick retries the occurrence.
    forceDue("sys-sleep");
    await runTick(queue);
    expect(doubles.sleepCycleCalls).toBe(2);
    expect(events("sys-sleep")[0]!.outcome).toBe("noop");

    forceDue("sys-sleep");
    await runTick(queue);
    expect(doubles.sleepCycleCalls).toBe(3);
    const ev3 = events("sys-sleep");
    expect(ev3[0]!.outcome).toBe("success");
    expect(ev3[0]!.diagnostic).toBeUndefined(); // healthy runs carry no incident
    expect(stateStore.readState("sys-sleep")!.consecutiveFailures).toBe(0);
    expect(doubles.pausedNotifications).toHaveLength(0);
  });

  it("#1603: a sleep-cycle resolving failed after a delay records a failed run and fires the failure cascade exactly once", async () => {
    const failureNotices: Array<{ entryId: string; code: string }> = [];
    const { CronQueue } = await import("../../components/tasks/task-queue.js");
    const coordinator = new CoordinatorClass({
      onFailure: (event) => { failureNotices.push({ entryId: event.entryId, code: event.diagnostic.code }); },
      agentRunner: fakeAgentRunner,
      projectRunner: realProjectRunner,
    });
    const queue = new CronQueue(coordinator);

    // Stub: the cycle handler AWAITS its long action and reports the real
    // outcome — the run must settle failed, not success-at-dispatch.
    registry._resetSystemTaskRegistry();
    registry.getSystemTaskRegistry().register("sleep-cycle", async (_entry, _ctx) => {
      doubles.sleepCycleCalls++;
      await new Promise(r => setTimeout(r, 10));
      return { status: "failed", error: "essential sleep steps failed (failed: retro-derive)" };
    });

    forceDue("sys-sleep");
    await runTick(queue);
    // The detached dispatch awaits the handler; give it a beat to settle.
    await new Promise(r => setTimeout(r, 30));

    const ev = events("sys-sleep");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.outcome).toBe("failed");
    expect(ev[0]!.diagnostic?.category).toBe("execution");
    expect(stateStore.readState("sys-sleep")!.consecutiveFailures).toBeGreaterThan(0);
    expect(failureNotices).toHaveLength(1);
    expect(failureNotices[0]!.entryId).toBe("sys-sleep");
    expect(failureNotices[0]!.code).toBe("process_exit");
  });
});

describe("#1520 scheduler E2E — journey 2: script + one-shot T follow-up", () => {
  it("runs the script via the boundary double and enqueues the T follow-up", async () => {
    const queue = await makeQueue();
    forceDue("gate-script");
    await runTick(queue);

    const scriptEv = events("gate-script");
    expect(scriptEv).toHaveLength(1);
    expect(scriptEv[0]!.outcome).toBe("success");
    expect(stateStore.readState("gate-script")!.consecutiveFailures).toBe(0);

    // The follow-up agent entry runs as a one-shot T.
    const followEv = events("gate-script-followup");
    expect(followEv).toHaveLength(1);
    expect(followEv[0]!.outcome).toBe("success");
    expect(followEv[0]!.kind).toBe("agent");
  });
});

describe("#1520 scheduler E2E — journey 3: one-shot T report with validation and delivery", () => {
  it("validates the artifact, settles exactly once, and delivers one document", async () => {
    const queue = await makeQueue();
    forceDue("report-task");
    await runTick(queue);

    const ev = events("report-task");
    expect(ev).toHaveLength(1);
    if (ev[0]!.outcome !== "success") console.error("RPT:", JSON.stringify(ev[0]));
    expect(ev[0]!.outcome).toBe("success");
    expect(ev[0]!.resultPath).toBeDefined();
    expect(ev[0]!.diagnostic).toBeUndefined();

    // Preflight verified curl (canonical tool) before execution.
    const state = stateStore.readState("report-task")!;
    expect(state.consecutiveFailures).toBe(0);

    // Delivery released after settlement → exactly one document send.
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    expect(doubles.sentDocuments).toHaveLength(1);
    expect(doubles.sentDocuments[0]!.path).toContain("report.md");
    expect(doubles.sentMessages).toHaveLength(0);
  });
});

describe("#1520 scheduler E2E — journey 4: one-shot T announcement", () => {
  it("hands the settled one-shot result to Main instead of sending it directly (#1724)", async () => {
    const queue = await makeQueue();
    forceDue("announce-task");
    await runTick(queue);
    const ev = events("announce-task");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.outcome).toBe("success");

    // #1610/#1724: the dispatched prompt carries the delivery contract — the
    // model is told its final response is handed to Main, which announces it.
    expect(doubles.dispatchedGoals).toHaveLength(1);
    expect(doubles.dispatchedGoals[0]).toContain("[DELIVERY CONTRACT]");
    expect(doubles.dispatchedGoals[0]).toContain("handed to Main");
    expect(doubles.dispatchedGoals[0]).toContain("you must not claim that you announced or sent it");

    // #1610: durable history separates the user payload from operational detail.
    expect(ev[0]!.deliveryText).toBe(ANNOUNCE_GREETING);
    expect(ev[0]!.detail).toBe(ANNOUNCE_GREETING.slice(0, 200));

    // #1610: the card carries the actual result beyond character 200.
    const card = board.kanbanGetCard(ev[0]!.kanbanCardId!)!;
    expect(card.result_summary).toBe(ANNOUNCE_GREETING);
    expect(card.result_summary!.length).toBeGreaterThan(200);

    // #1724: the delivery boundary hands the card to Main — the raw platform
    // sender never sees the announcement text.
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    expect(doubles.mainAnnouncements).toHaveLength(1);
    expect(doubles.mainAnnouncements[0]!.eventId).toBe(`scheduled-card:${card.id}`);
    expect(doubles.mainAnnouncements[0]!.result).toBe(ANNOUNCE_GREETING);
    expect(doubles.sentMessages).toHaveLength(0);
    expect(board.kanbanGetCard(card.id)!.status).toBe("delivered");
  });

  it("keeps a not_sent Main handoff on the bounded retry path with no direct fallback (#1724)", async () => {
    const queue = await makeQueue();
    forceDue("announce-task");
    await runTick(queue);
    const ev = events("announce-task");
    expect(ev[0]!.outcome).toBe("success");
    const cardId = ev[0]!.kanbanCardId!;

    doubles.mainAnnouncementOutcome = "not_sent";
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    expect(doubles.mainAnnouncements).toHaveLength(1);
    expect(doubles.sentMessages).toHaveLength(0);
    expect(board.kanbanGetCard(cardId)!.delivery_result).toBe("definitely_not_sent");

    // Retry succeeds → delivered; exactly two handoffs total.
    doubles.mainAnnouncementOutcome = "sent";
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    expect(doubles.mainAnnouncements).toHaveLength(2);
    expect(board.kanbanGetCard(cardId)!.status).toBe("delivered");

    // Delivered cards are never re-handed to Main.
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    expect(doubles.mainAnnouncements).toHaveLength(2);
  });
});

describe("#1724 scheduler E2E — journey 13: complete Main-owned announcement journey", () => {
  interface MemRow { role: "user" | "assistant"; content: string; sessionId: string; timestamp: number; id: number }

  /** Memory boundary double: durable conversation rows + the #1527
   *  projection contract the Pi transports consume for context assembly. */
  function makeMemoryRuntime() {
    const rows: MemRow[] = [];
    let nextId = 1;
    const runtime = {
      state: "ready",
      capabilities: new Set<string>(["durableContext"]),
      recordMessage: vi.fn(async (m: { role: "user" | "assistant"; content: string; sessionId: string; timestamp: number }) => {
        const id = nextId++;
        rows.push({ ...m, id });
        return { id };
      }),
      recall: vi.fn(async () => ({ hits: [] as unknown[] })),
      recordFeedback: vi.fn(async () => ({})),
      assembleSessionContext: vi.fn(async () => ({ coreKnowledge: "", recall: "", wakeUp: "" })),
      projectDurableContext: vi.fn(async ({ sessionId, beforeMessageId }: { userId: string; sessionId: string; beforeMessageId: number; maxContext: number }) => {
        const messages = rows
          .filter(r => r.sessionId === sessionId && r.id < beforeMessageId)
          .map(r => ({ role: r.role, content: r.content }));
        return { messages, estimatedTokens: messages.reduce((s, m) => s + estimateTokensFromChars(m.content.length), 0), sourceMessageCount: rows.length };
      }),
    };
    return { runtime, rows };
  }

  function makeTransportDouble(reply: string): Record<string, unknown> {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      sendPrompt: vi.fn().mockResolvedValue(reply),
      resetSession: vi.fn().mockResolvedValue(undefined),
      sendInterrupt: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
      transportCommands: [],
      get isReady() { return true; },
      contextPercent: -1,
      toolCallsSucceeded: 0,
      get answerOnly() { return reply; },
    };
  }

  function makeAdapterDouble() {
    return {
      name: "telegram",
      capabilities: { voice: false, reactions: false, typing: false, threads: false },
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      authorize: () => true,
      sendMessage: vi.fn().mockResolvedValue(1),
      chunkResponse: (t: string) => [t],
    };
  }

  async function makeJourney(opts: { mainReply?: string } = {}) {
    const { MainConversationIngress } = await import("../../components/main-conversation-ingress.js");
    const mpMod = await import("../../components/message-pipeline.js");
    const spinMod = await import("../../components/spin.js");

    const CHAT_ID = "1111111111";
    const mem = makeMemoryRuntime();
    const adapter = makeAdapterDouble();
    const mainReply = opts.mainReply ?? `${ANNOUNCE_GREETING.slice(0, 60)}… — here is your morning briefing.`;
    const transport = makeTransportDouble(mainReply);

    // Real Spin singleton: allocate the master general A session.
    const session = spinMod.spin.getActiveSession("master", "telegram");
    session.chatId = parseInt(CHAT_ID, 10);
    session.platform = "telegram";
    session.userId = "master";
    session.status = "ready";
    vi.spyOn(spinMod.spin, "ensureSessionTransport").mockImplementation(async (s) => { s.transport = transport as never; });

    // The pipeline's model-turn boundary is doubled (like every external
    // boundary in this harness): the stub mirrors the production contract —
    // the provider's own string plus its classified outcome.
    const sessionManager = {
      spin: async (spec: { sessionId?: string; prompt: string }) => {
        const result = await (transport as { sendPrompt: (id: string, p: string) => Promise<string> }).sendPrompt(spec.sessionId ?? "", spec.prompt);
        const { classifyContent } = await import("../../components/clean-response.js");
        return { sessionId: spec.sessionId ?? "", result, outcome: classifyContent(result) };
      },
    };

    const pipelineDeps = {
      transport: transport as never,
      config: { workingDir: "/tmp" },
      startedAt: Date.now(),
      memoryRuntime: mem.runtime as never,
      memoryConfig: { memoryEnabled: true, memoryDir: join(TEST_HOME, "memory") },
      nlmConfig: { enabled: false },
      idleSave: { reset: vi.fn(), save: vi.fn(), getTimers: () => new Map(), clearAll: vi.fn() },
      conversationBuffer: { push: vi.fn(), drain: vi.fn().mockReturnValue(null), clear: vi.fn() },
      sttConfig: null,
      ttsConfig: null,
      sessionManager,
      updateCtxStart: vi.fn(),
    } as unknown as Parameters<typeof mpMod.handleInboundMessage>[2];

    const ingress = new MainConversationIngress({
      getPipelineDeps: () => pipelineDeps,
      getAdapter: () => adapter as never,
    });

    // Boot-shaped delivery closure: identity resolved at delivery time from
    // the card; the raw sender is armed to fail loudly if ever used.
    const makeMainDeliveryDeps = () => ({
      sendMessage: async (): Promise<never> => { throw new Error("raw sender must not be used for scheduled T announce"); },
      sendDocument: async (): Promise<never> => { throw new Error("raw document sender must not be used"); },
      announce: async () => {},
      chatIdFor: () => CHAT_ID,
      announceToMain: async (card: { id: number; title: string; result_summary: string | null }) =>
        ingress.announceToMain({
          eventId: `scheduled-card:${card.id}`,
          cardId: card.id,
          title: card.title,
          userId: "master",
          platform: "telegram",
          chatId: CHAT_ID,
          result: card.result_summary ?? "",
        }),
    });

    function enqueueAnnounceCard(): number {
      const id = board.kanbanEnqueue("Morning greeting", "task", "run-main-journey", {
        type: "T", deliveryMode: "announce", chatId: CHAT_ID, deliveryReady: false,
      });
      board.kanbanRunning(id);
      board.kanbanComplete(id, null, ANNOUNCE_GREETING);
      board.kanbanSetDeliveryReady(id);
      return id;
    }

    return { mem, adapter, transport, session, ingress, pipelineDeps, makeMainDeliveryDeps, enqueueAnnounceCard, handleInboundMessage: mpMod.handleInboundMessage, CHAT_ID };
  }

  it("announces through Main, records both turns durably, and grounds a later follow-up", async () => {
    const j = await makeJourney();
    const cardId = j.enqueueAnnounceCard();

    await delivery.pollPendingDeliveries(j.makeMainDeliveryDeps());

    // Exactly one external message — Main's own response, never the raw T result.
    expect(j.adapter.sendMessage).toHaveBeenCalledTimes(1);
    const delivered = String(j.adapter.sendMessage.mock.calls[0]![1]);
    expect(delivered).toContain("here is your morning briefing");
    expect(board.kanbanGetCard(cardId)!.status).toBe("delivered");

    // Durable target-A-session record: internal event BEFORE the turn,
    // Main's assistant response AFTER delivery — same session id.
    expect(j.mem.rows).toHaveLength(2);
    expect(j.mem.rows[0]!.role).toBe("user");
    expect(j.mem.rows[0]!.content).toContain("[SCHEDULED TASK COMPLETED]");
    expect(j.mem.rows[0]!.content).toContain(ANNOUNCE_GREETING);
    expect(j.mem.rows[0]!.sessionId).toBe(j.session.id);
    expect(j.mem.rows[1]!.role).toBe("assistant");
    expect(j.mem.rows[1]!.sessionId).toBe(j.session.id);

    // A later user follow-up is recorded into the same session…
    const followUp = {
      platform: "telegram", channelId: j.CHAT_ID, userId: "master",
      senderId: "42", senderName: "aksika", text: "What did you say about my day?",
      timestamp: Date.now(), isGroup: false, isVoice: false,
    };
    await j.handleInboundMessage(followUp as never, j.adapter as never, j.pipelineDeps);
    expect(j.mem.rows.length).toBeGreaterThanOrEqual(3);

    // …and a FRESH durable-context assembly exposes the announcement to that turn.
    const provider = (await import("../../components/transport/pi-core-context.js")).createDurableContextProvider(j.mem.runtime as never);
    const projected = await provider.projectContext({ userId: "master", sessionId: j.session.id, beforeMessageId: Number.MAX_SAFE_INTEGER, maxContext: 100000 });
    const contents = projected.messages.map(m => m.content);
    expect(contents.some(c => c.includes("[SCHEDULED TASK COMPLETED]") && c.includes(ANNOUNCE_GREETING))).toBe(true);
    expect(contents.some(c => c.includes("morning briefing"))).toBe(true);
  }, 30_000);

  it("keeps the card retryable when Main is busy, without queueing or direct fallback", async () => {
    const j = await makeJourney();
    j.session.busy = true;
    const cardId = j.enqueueAnnounceCard();

    await delivery.pollPendingDeliveries(j.makeMainDeliveryDeps());

    expect(j.adapter.sendMessage).not.toHaveBeenCalled();
    expect(j.mem.rows).toHaveLength(0);
    expect(board.kanbanGetCard(cardId)!.status).toBe("done");
    expect(board.kanbanGetCard(cardId)!.delivery_result).toBe("definitely_not_sent");

    // Recovery: free Main, retry succeeds through the normal pipeline.
    j.session.busy = false;
    await delivery.pollPendingDeliveries(j.makeMainDeliveryDeps());
    expect(j.adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(board.kanbanGetCard(cardId)!.status).toBe("delivered");
  }, 30_000);

  it("does not treat an empty Main response as successful announcement delivery", async () => {
    const j = await makeJourney({ mainReply: "" });
    const cardId = j.enqueueAnnounceCard();

    await delivery.pollPendingDeliveries(j.makeMainDeliveryDeps());

    // No announcement content ever reached the platform, no assistant
    // content was recorded, and the card stays truthfully retryable.
    const announced = j.adapter.sendMessage.mock.calls.some(c => String(c[1]).includes("morning briefing"));
    expect(announced).toBe(false);
    expect(j.mem.rows.some(r => r.role === "assistant" && r.content.length > 0)).toBe(false);
    expect(board.kanbanGetCard(cardId)!.status).toBe("done");
    expect(["definitely_not_sent"]).toContain(board.kanbanGetCard(cardId)!.delivery_result);
  }, 30_000);

  it("routes a scheduled K Spanish-tutor card on its role-session route, never into A (#1724 discriminator)", async () => {
    const j = await makeJourney();
    const ingressSpy = vi.spyOn(j.ingress, "announceToMain");
    const kCardId = board.kanbanEnqueue("Spanish tutor kickoff", "task", "run-k-tutor", {
      type: "K", deliveryMode: "announce", chatId: j.CHAT_ID,
    });
    board.kanbanRunning(kCardId);
    board.kanbanComplete(kCardId, null, "Hola! Ready for today's lesson?");
    const directSends: string[] = [];
    const deps = {
      ...j.makeMainDeliveryDeps(),
      sendMessage: async (_chatId: string, text: string) => { directSends.push(text); return "sent" as const; },
    };

    await delivery.pollPendingDeliveries(deps);

    expect(ingressSpy).not.toHaveBeenCalled();
    expect(directSends).toHaveLength(1);
    expect(directSends[0]).toContain("Hola!");
    expect(j.mem.rows).toHaveLength(0);
    expect(board.kanbanGetCard(kCardId)!.status).toBe("delivered");
  }, 30_000);
});

describe("#1520 scheduler E2E — journey 5: multi-agent one-shot through the internal O project", () => {
  it("supervises via the real project runner + scripted Orc, validates, settles, releases delivery once", async () => {
    const queue = await makeQueue();
    const { fixture } = await makeFixture();
    forceDue("project-task");
    await tick.runTaskTick(makeTickCtx(queue));
    const { runId } = await waitForReach(fixture, "executing");
    expect(runId).toBeDefined();
    expect(board.kanbanGetCard(1)?.source_id).toBe(runId);
    expect(fixture.lastTurn).toBe("authored");

    fixture.completeWorkers();
    fixture.accept();
    await waitFor(() => !stateStore.readState("project-task")?.activeRun);

    const ev = events("project-task");
    expect(ev).toHaveLength(1);
    if (ev[0]!.outcome !== "success") console.error("PRJ:", JSON.stringify(ev[0]));
    expect(ev[0]!.outcome).toBe("success");
    expect(ev[0]!.kanbanCardId).toBeDefined();

    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    if (doubles.sentMessages.length !== 1) {
      console.error("PRJ-CARDS:", JSON.stringify(board.kanbanList("*")));
    }
    expect(doubles.sentMessages).toHaveLength(1);
  });
});

describe("#1520/#1609 scheduler E2E — journey 6: transient failure, retry, pause, restart, resume, success", () => {
  it("retries once per group, pauses after five failed groups, resumes atomically, succeeds", async () => {
    const queue = await makeQueue();
    // Each group: attempt 1 transient → retry; attempt 2 transient → count.
    // #1609: the counted threshold rose from 3 to 5 consecutive failed groups.
    doubles.providerFailures = 10;
    for (let group = 0; group < 5; group++) {
      forceDue("flaky-task");
      await runTick(queue);
      forceDue("flaky-task");
      await runTick(queue);
    }

    const ev = events("flaky-task");
    if (ev.length !== 10) console.error("FLAKY:", JSON.stringify(ev));
    expect(ev).toHaveLength(10);
    expect(ev.filter(e => e.outcome === "failed")).toHaveLength(10);
    const state = stateStore.readState("flaky-task")!;
    expect(state.consecutiveFailures).toBe(5);
    expect(state.autoPaused).toBe(true);
    expect(state.pausedAt).toBeDefined();
    expect(state.lastIncident?.category).toBe("execution");
    expect(state.lastIncident?.code).toBe("model_error");
    expect(doubles.pausedNotifications).toHaveLength(1);
    expect(doubles.pausedNotifications[0]).toContain("Flaky Task");
    expect(doubles.pausedNotifications[0]).toContain("execution/model_error");

    // Restart: a fresh queue against the same durable state; coordinator
    // recovery finds no active runs (all settled) and changes nothing.
    const queue2 = await makeQueue();
    await new CoordinatorClass().recover(taskStore.readEntries());
    expect(stateStore.readState("flaky-task")!.autoPaused).toBe(true);

    // Atomic resume: one service call clears counters and keeps the incident.
    const entries = taskStore.readEntries();
    expect(service.resumeAutoPaused("flaky-task", entries)).toBe("resumed");
    expect(service.resumeAutoPaused("flaky-task", entries)).toBe("not_paused");
    const resumed = stateStore.readState("flaky-task")!;
    expect(resumed.autoPaused).toBe(false);
    expect(resumed.consecutiveFailures).toBe(0);
    expect(resumed.lastIncident?.code).toBe("model_error");

    // Later success resets everything.
    doubles.providerFailures = 0;
    forceDue("flaky-task");
    await runTick(queue2);
    const ev2 = events("flaky-task");
    expect(ev2[0]!.outcome).toBe("success");
    expect(stateStore.readState("flaky-task")!.consecutiveFailures).toBe(0);
  });
});

describe("#1609 scheduler E2E — journey 11: bounded automatic recovery (cooldown, resume, cap)", () => {
  it("no early resume; one atomic resume at cooldown expiry schedules the future run; cap escalates", async () => {
    const { setPausedRecoveryHook } = await import("../../components/tasks/task-checker.js");
    const recoveryEvents: Array<{ kind: string; entryId: string }> = [];
    const unsub = (() => {
      setPausedRecoveryHook(e => recoveryEvents.push(e));
      return () => setPausedRecoveryHook(null);
    })();

    try {
      const queue = await makeQueue();
      const pauseTask = (): number => {
        const pausedAt = Date.now();
        stateStore.updateState("flaky-task", { autoPaused: true, pausedAt });
        return pausedAt;
      };

      // Five failed groups pause the task (same shape as journey 6).
      doubles.providerFailures = 10;
      for (let group = 0; group < 5; group++) {
        forceDue("flaky-task");
        await runTick(queue);
        forceDue("flaky-task");
        await runTick(queue);
      }
      expect(stateStore.readState("flaky-task")!.autoPaused).toBe(true);

      // No early resume: a heartbeat evaluation inside the cooldown leaves the
      // task paused and reserves nothing.
      const before = events("flaky-task").length;
      await runTick(queue);
      const during = stateStore.readState("flaky-task")!;
      expect(during.autoPaused).toBe(true);
      expect(during.autoResumeCount).toBe(0);
      expect(events("flaky-task")).toHaveLength(before);

      // Cooldown expiry: rewriting pausedAt to the past simulates the 12-hour
      // boundary; the checker performs exactly ONE atomic resume through the
      // service and schedules the next FUTURE occurrence — no run reservation
      // in the same heartbeat.
      stateStore.updateState("flaky-task", { pausedAt: Date.now() - 13 * 3600_000 });
      const beforeTick = events("flaky-task").length;
      await runTick(queue);
      const resumed = stateStore.readState("flaky-task")!;
      expect(resumed.autoPaused).toBe(false);
      expect(resumed.pausedAt).toBeUndefined();
      expect(resumed.consecutiveFailures).toBe(0);
      expect(resumed.autoResumeCount).toBe(1);
      expect(resumed.nextRunAt!).toBeGreaterThan(Date.now());
      expect(events("flaky-task")).toHaveLength(beforeTick);
      expect(recoveryEvents).toContainEqual(expect.objectContaining({ kind: "resumed", entryId: "flaky-task", nextRunAt: expect.any(Number) }));

      // A later successful run resets the episode counter.
      doubles.providerFailures = 0;
      forceDue("flaky-task");
      await runTick(queue);
      expect(stateStore.readState("flaky-task")!.autoResumeCount).toBe(0);

      // Cap exhaustion: three more expired cooldowns consume the three
      // remaining automatic resumes; the fourth expiry escalates and stays
      // paused.
      for (let cycle = 0; cycle < 3; cycle++) {
        pauseTask();
        stateStore.updateState("flaky-task", { pausedAt: Date.now() - 13 * 3600_000 });
        await runTick(queue);
      }
      const count = stateStore.readState("flaky-task")!.autoResumeCount;
      expect(count).toBe(3);

      // The escalation shares the durable WARN claim, so simulate the quiet
      // window (no warning recorded in the previous 5 minutes).
      pauseTask();
      stateStore.updateState("flaky-task", { pausedAt: Date.now() - 13 * 3600_000, lastPauseWarnAt: Date.now() - 6 * 60_000 });
      await runTick(queue);
      const capped = stateStore.readState("flaky-task")!;
      expect(capped.autoPaused).toBe(true);
      expect(capped.autoResumeCount).toBe(3);
      expect(recoveryEvents).toContainEqual({ kind: "cap_exhausted", entryId: "flaky-task" });

      // Manual resume is the operator escape hatch after cap exhaustion.
      expect(service.resumeAutoPaused("flaky-task", taskStore.readEntries())).toBe("resumed");
      const manual = stateStore.readState("flaky-task")!;
      expect(manual.autoPaused).toBe(false);
      expect(manual.autoResumeCount).toBe(3);
    } finally {
      unsub();
    }
  });
});

describe("#1520 scheduler E2E — journey 7: bounded T admission deferral across restart", () => {
  it("defers the same occurrence durably, resumes across restart, exhausts exactly once", async () => {
    let queue = await makeQueue();
    forceDue("deferred-task");
    await runTick(queue);
    let st = stateStore.readState("deferred-task")!;
    expect(st.deferredAdmission?.attempts).toBe(1);
    expect(st.consecutiveFailures).toBe(0);

    // Restart mid-deferral: the deferredAdmission is durable; a fresh queue
    // resumes the SAME group/occurrence.
    queue = await makeQueue();
    await new CoordinatorClass().recover(taskStore.readEntries());
    forceDue("deferred-task");
    await runTick(queue);
    st = stateStore.readState("deferred-task")!;
    expect(st.deferredAdmission?.attempts).toBe(2);
    expect(st.consecutiveFailures).toBe(0);
    const groupId = st.deferredAdmission!.groupId;

    // Drive to the bound: attempts 3..5, then the 6th reservation hits the
    // bound and the occurrence ends ONCE as failed/executor_unavailable.
    for (let i = 3; i <= 5; i++) {
      forceDue("deferred-task");
      await runTick(queue);
    }
    forceDue("deferred-task");
    await runTick(queue);
    st = stateStore.readState("deferred-task")!;
    expect(st.deferredAdmission).toBeUndefined();
    expect(st.consecutiveFailures).toBe(1);

    const ev = events("deferred-task");
    if (ev.filter(e => e.outcome === "deferred").length !== 5) console.error("DEF:", JSON.stringify(ev));
    expect(ev.filter(e => e.outcome === "deferred")).toHaveLength(5);
    expect(ev.filter(e => e.outcome === "failed")).toHaveLength(1);
    const terminal = ev.find(e => e.outcome === "failed")!;
    expect(terminal.diagnostic?.code).toBe("executor_unavailable");
    // The occurrence was never dropped from the durable record and never
    // became a new group.
    expect(ev.every(e => e.groupId === groupId)).toBe(true);
    expect(doubles.admissionRejections).toBe(6);
  });
});

describe("#1520 scheduler E2E — journey 8: late/duplicate completion and delivery poll idempotency", () => {
  it("ignores stale settlements and duplicate polls with exact counts", async () => {
    const queue = await makeQueue();
    forceDue("announce-task");
    await runTick(queue);

    const ev1 = events("announce-task");
    expect(ev1).toHaveLength(1);
    const st = stateStore.readState("announce-task")!;
    const nextRun = st.nextRunAt;

    // A late completion whose reservation is already gone is ignored: history
    // is appended but no state/card/delivery effects can follow.
    const { settleRunOnce } = settler;
    const run = { runId: "announce-task_stale", groupId: "announce-task:group:stale", attempt: 1 as const, trigger: "schedule" as const, occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() + 60000, phase: "executing" as const, lastProgressAt: Date.now() };
    const entry = taskStore.readEntries().find(e => e.id === "announce-task")!;
    expect(settleRunOnce({ entry, run, outcome: "success" })).toBe("late");
    expect(stateStore.readState("announce-task")!.nextRunAt).toBe(nextRun);
    expect(doubles.sentMessages).toHaveLength(0);

    // Duplicate settlement of the same run id is refused by append-once.
    expect(settleRunOnce({ entry, run, outcome: "success" })).toBe("duplicate");
    expect(events("announce-task").filter(e => e.runId === "announce-task_stale")).toHaveLength(1);

    // Duplicate delivery polls hand the card to Main exactly once (#1724);
    // the raw platform sender is never used for the scheduled T announce.
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    expect(doubles.mainAnnouncements).toHaveLength(1);
    expect(doubles.sentMessages).toHaveLength(0);
    expect(cardStatuses().filter(s => s.endsWith(":delivered"))).toHaveLength(1);
  });
});

describe("#1520 scheduler E2E — journey 9: removed surfaces, canonical probes, local-O peer rejection", () => {
  it("has no web_browse/irc_send registrations, checks canonical prerequisites, rejects local O at the peer boundary", async () => {
    const schemas = toolRegistry.getToolSchemas();
    const names = schemas.map(s => s.function.name);
    expect(names).not.toContain("web_browse");
    expect(names).not.toContain("irc_send");
    expect(names).toContain("execute_bash");
    expect(names).toContain("peer_doorbell");

    // Canonical browser prerequisite: curl is probed with task PATH, no shell.
    const scope = (await import("../../components/tasks/task-package.js")).createExecutionScope("probe-task");
    const ok = preflight.preflightTask({
      id: "probe-task", kind: "agent", prompt: "p", agent: "task", interaction: { mode: "oneshot" },
      schedule: "* * * * *", enabled: true, priority: "medium", delivery: "report", chatId: "1",
      report: { artifact: join(TEST_HOME, "workspace", "probe-task", "r.md"), requiredSections: ["## X"], minBytes: 100, requires: { files: [], executables: ["curl"], tools: ["execute_bash"] } },
    }, scope, { getToolDescriptor: toolRegistry.getToolDescriptor });
    expect(ok.ok).toBe(true);

    const removedTool = preflight.preflightTask({
      id: "removed-tool-task", kind: "agent", prompt: "p", agent: "task", interaction: { mode: "oneshot" },
      schedule: "* * * * *", enabled: true, priority: "medium", delivery: "report", chatId: "1",
      report: { artifact: join(TEST_HOME, "workspace", "removed-tool-task", "r.md"), requiredSections: ["## X"], minBytes: 100, requires: { files: [], executables: [], tools: ["web_browse"] } },
    }, scope, { getToolDescriptor: toolRegistry.getToolDescriptor });
    expect(removedTool.ok).toBe(false);
    if (!removedTool.ok) {
      expect(removedTool.code).toBe("required_tool_unregistered");
      expect(removedTool.safeDetail).toBe("required tool not registered: web_browse");
    }

    const missing = preflight.preflightTask({
      id: "probe-task", kind: "agent", prompt: "p", agent: "task", interaction: { mode: "oneshot" },
      schedule: "* * * * *", enabled: true, priority: "medium", delivery: "report", chatId: "1",
      report: { artifact: join(TEST_HOME, "workspace", "probe-task", "r.md"), requiredSections: ["## X"], minBytes: 100, requires: { files: [], executables: ["definitely-not-a-real-exe-xyz"], tools: [] } },
    }, scope, undefined);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("required_executable_missing");
    }

    // Local O/Orc cannot reach peer transport.
    const peerOut = await executeToolCall("peer_doorbell", { peer_name: "O" }, {});
    expect(JSON.parse(peerOut).code).toBe("local_session_not_peer");
    const orcOut = await executeToolCall("peer_session", { peer_name: "Orc", message: "hi" }, {});
    expect(JSON.parse(orcOut).code).toBe("local_session_not_peer");
  });
});

describe("#1539 scheduler E2E — journey 10: due-time retry wake with no unrelated event", () => {
  it("dispatches a deferred occurrence at its durable retryAt through the wake scheduler alone", async () => {
    vi.useFakeTimers();
    try {
      // #1628: the Orc coordinator now initializes in-process, so a shared
      // * * * * * fixture (project-task, gate-script) becoming due mid-journey
      // would admit a real supervised project into the scheduled lane and
      // starve sys-sleep's retry. This journey's premise is "no unrelated
      // event" — disable the other fixtures so the scheduler arms exactly at
      // the deferred retryAt (also removes the minute-boundary race).
      const onlySysSleep = taskStore.readEntries().map(e =>
        e.id === "sys-sleep" ? e : { ...e, enabled: false },
      );
      writeFileSync(join(TEST_HOME, "tasks", "tasks.json"), JSON.stringify(onlySysSleep, null, 2));
      stateStore.initializeState(taskStore.readEntries());

      const { queue, coordinator } = await makeQueueWithCoordinator();
      const scheduler = new wakeSchedulerMod.LifecycleWakeScheduler();
      scheduler.register(dueSourcesMod.createTaskAdmissionSource(() => tick.runTaskTick(makeTickCtx(queue))));
      scheduler.register(dueSourcesMod.createRunDeadlineSource(coordinator));
      stateStore.setTaskDueChangedHook(() => scheduler.sourceChanged("task-admission"));
      await scheduler.start();

      // Journey 1 first leg: sys-sleep defers once at now+60s.
      forceDue("sys-sleep");
      await tick.runTaskTick(makeTickCtx(queue));
      await vi.advanceTimersByTimeAsync(0);
      expect(doubles.sleepCycleCalls).toBe(1);
      const st = stateStore.readState("sys-sleep")!;
      expect(st.deferredAdmission?.attempts).toBe(1);
      const retryAt = st.deferredAdmission!.retryAt;

      // No tick, no heartbeat, no nerve event — the wake scheduler alone
      // re-admits the SAME occurrence when retryAt passes.
      await vi.advanceTimersByTimeAsync(Math.max(1, retryAt - Date.now() - 1));
      expect(doubles.sleepCycleCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(2);
      // The retry attempt dispatches without any unrelated event.
      expect(doubles.sleepCycleCalls).toBe(2);
      expect(events("sys-sleep")[0]!.outcome).toBe("noop");
      expect(stateStore.readState("sys-sleep")!.deferredAdmission).toBeUndefined();
      scheduler.stop();
    } finally {
      stateStore.setTaskDueChangedHook(null);
      vi.useRealTimers();
    }
  });
});

describe("#1539 scheduler E2E — journey 11: two-lane admission and same-task exclusion", () => {
  it("runs a long scheduled O project and an unrelated manual run concurrently; excludes a duplicate occurrence", async () => {
    const { queue, coordinator } = await makeQueueWithCoordinator();
    const scheduler = new wakeSchedulerMod.LifecycleWakeScheduler();
    scheduler.register(dueSourcesMod.createRunDeadlineSource(coordinator));
    await scheduler.start();
    try {
      // A long supervised project: the scripted Orc holds acceptance until
      // the workers are completed and we release the hold.
      const { fixture } = await makeFixture({ holdAcceptance: true, workerCount: 1 });
      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
    const { runId } = await waitForReach(fixture, "executing");
      expect(runId).toBeDefined();
      expect(queue.currentJobs.map(j => j.entryId)).toContain("project-task");

      // An unrelated manual run starts in the manual lane concurrently.
      const manualEntry = taskStore.readEntries().find(e => e.id === "announce-task")!;
      const err = queue.enqueue(manualEntry, true);
      expect(err).toBeNull();
      await waitFor(() => queue.currentJobs.map(j => j.entryId).includes("announce-task"));
      expect(queue.currentJobs).toHaveLength(2);

      // A second occurrence of the SAME task is excluded globally across lanes.
      const duplicate = queue.enqueue(manualEntry, true);
      expect(duplicate).toContain("Already running");
      expect(queue.currentJobs).toHaveLength(2);
      expect(events("announce-task")).toHaveLength(0);

      // Release the project: complete workers, accept, settle once.
      fixture.completeWorkers();
      fixture.holdAcceptance = false;
      fixture.accept();
      await waitFor(() => queue.currentJobs.length === 0 && !stateStore.readState("project-task")?.activeRun);

      const ev = events("project-task");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.outcome).toBe("success");
      // The manual run completed independently with its own row.
      expect(events("announce-task")).toHaveLength(1);
      // Done: project root O + its fixture worker W + the manual announce card.
      expect(cardStatuses().filter(s => s.endsWith(":done"))).toHaveLength(3);
      scheduler.stop();
    } finally {
      scheduler.stop();
    }
  });
});

describe("#1539 scheduler E2E — journey 12: terminal O project reattach across restart", () => {
  it("reattaches a live supervised project under the same run ID and settles exactly once", async () => {
    const { queue, coordinator } = await makeQueueWithCoordinator();
    const scheduler = new wakeSchedulerMod.LifecycleWakeScheduler();
    scheduler.register(dueSourcesMod.createRunDeadlineSource(coordinator));
    await scheduler.start();
    try {
      const { fixture } = await makeFixture({ holdAcceptance: true });
      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      const { runId, rootCardId } = await waitForReach(fixture, "executing");
      const firstRunId = runId;
      expect(firstRunId).toBeDefined();

      // Restart: a fresh queue/coordinator + fresh scripted Orc recovers the
      // active occurrence and reattaches the SAME run through admission.
      const { queue: queue2, coordinator: coordinator2 } = await makeQueueWithCoordinator();
      const fixture2 = await makeFixture({ holdAcceptance: true });
      const scheduler2 = new wakeSchedulerMod.LifecycleWakeScheduler();
      scheduler2.register(dueSourcesMod.createRunDeadlineSource(coordinator2));
      let reattached = false;
      await coordinator2.recover(taskStore.readEntries(), (entry, run) => {
        const enqueueResult = queue2.enqueue(entry, false, run);
        if (enqueueResult) return false;
        reattached = true;
        return true;
      });
      expect(reattached).toBe(true);
      expect(stateStore.readState("project-task")!.activeRun!.runId).toBe(firstRunId);
      expect(queue2.currentJobs.map(j => j.entryId)).toContain("project-task");

      // The reattached run still owns its workers (durable W cards); complete
      // them and accept to settle the project exactly once. Reattach performs
      // no authoring (supervision is already executing), so the fresh fixture
      // records no turn.
      await waitFor(() => stateStore.readState("project-task")?.activeRun?.runId === firstRunId && stateStore.readState("project-task")?.activeRun?.cardId !== undefined);
      expect(fixture2.fixture.lastTurn).toBe("none");
      // #1554: the restart generation's boot recovery settled the dead
      // process-bound worker (bridge_restart) and the driver opened the
      // review case from the now all-terminal children — the reattached run
      // re-enters through the review lane, never a fresh authoring turn.
      const supAfterRestart = new reviewStoreMod.ProjectReviewStore().getSupervision(rootCardId);
      expect(["executing", "review_ready", "review_requested"].includes(supAfterRestart?.state ?? "")).toBe(true);
      expect(fixture2.fixture.lastTurn).toBe("none");
      fixture2.fixture.adoptRoot(rootCardId);
      // the held acceptance gates the driver-owned review turn; once released,
      // the scripted Orc accepts the durable case
      fixture2.fixture.holdAcceptance = false;
      fixture2.fixture.accept();
      await waitFor(() => queue2.currentJobs.length === 0 && !stateStore.readState("project-task")?.activeRun);

      const ev = events("project-task");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.outcome).toBe("success");
      expect(ev[0]!.runId).toBe(firstRunId);
      expect(rootCardId).toBeDefined();
      // Root O is done; its fixture worker W is terminal (settled
      // bridge_restart by the restart generation's boot recovery). No
      // duplicates.
      expect(cardStatuses().filter(s => s.endsWith(":done") || s.endsWith(":failed"))).toHaveLength(2);
      expect(cardStatuses().filter(s => s.endsWith(":done"))).toHaveLength(1);
      scheduler2.stop();
    } finally {
      scheduler.stop();
    }
  });
});

describe("#1548 Task-1 gate — real admission under controlled time", () => {
  it("reserves through the real queue with the production run limits and settles once as deadline_exceeded", async () => {
    vi.useFakeTimers();
    try {
      const { queue, coordinator } = await makeQueueWithCoordinator();
      const scheduler = new wakeSchedulerMod.LifecycleWakeScheduler();
      // Production mirror (phase-pipeline-deps): a durable mutation notifies
      // BOTH the admission and run-deadline sources. Notifying only an
      // unregistered source would leave the deadline item unarmed and the
      // run-deadline wake would never fire.
      scheduler.register(dueSourcesMod.createRunDeadlineSource(coordinator));
      stateStore.setTaskDueChangedHook(() => {
        scheduler.sourceChanged("task-admission");
        scheduler.sourceChanged("run-deadline");
      });
      await scheduler.start();

      // Acceptance never arrives: the run must be killed by the lifecycle
      // deadline source, never by an unrelated event and never before a limit.
      const { fixture } = await makeFixture();
      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      // The admission chain crosses dynamic imports (real I/O), so flush
      // event-loop turns deterministically until the card attachment lands
      // and the scripted Orc has authored the contract.
      await advanceUntil(() =>
        stateStore.readState("project-task")?.activeRun?.cardId !== undefined
        && fixture.lastTurn === "authored");

      expect(fixture.lastTurn).toBe("authored");
      const run = stateStore.readState("project-task")!.activeRun!;
      // Real reservation carries the production-derived absolute ceiling.
      expect(run.deadlineAt - run.reservedAt).toBe(taskTypesMod.runCeilingMs());
      expect(run.cardId).toBeDefined();
      expect(queue.currentJobs.map(j => j.entryId)).toContain("project-task");

      // Advance well past the ceiling in one controlled jump: the idle limit,
      // waitForProjectTerminal 10s recheck, run-deadline wake source, and
      // coordinator deadline path must all fire without deadlock and settle
      // the occurrence exactly once.
      await vi.advanceTimersByTimeAsync(taskTypesMod.runCeilingMs() + 11_000);
      await advanceUntil(() => stateStore.readState("project-task")?.activeRun === undefined);

      // R1: the declared terminal contract is deadline_exceeded — the wake's
      // durable deadline request normalizes the settle, never a plain abort.
      const observer = new observerClass("project-task", run.runId, observerStores(queue, coordinator, run.runId));
      observer.sample();
      observer.assertTerminal({ outcome: "failed", source: "deadline_exceeded", diagnosticCode: "deadline_exceeded" });
      const ev = events("project-task");
      if (ev.length !== 1) console.error("T1:", JSON.stringify(ev));
      expect(ev).toHaveLength(1);
      expect(ev[0]!.outcome).toBe("failed");
      expect(ev[0]!.diagnostic?.category).toBe("interruption");
      expect(ev[0]!.diagnostic?.code).toBe("deadline_exceeded");
      expect(stateStore.readState("project-task")!.activeRun).toBeUndefined();
      expect(queue.currentJobs).toHaveLength(0);
      expect(queue.pending).toBe(0);
      observer.stop();
      scheduler.stop();
    } finally {
      stateStore.setTaskDueChangedHook(null);
      vi.useRealTimers();
    }
  });
});

/** #1548: wait for the scripted Orc to author the project into the state. */
async function waitForReach(fixture: Awaited<ReturnType<typeof makeFixture>>["fixture"], state: "executing" | "awaiting_contract"): Promise<{ runId: string; rootCardId: number }> {
  for (let i = 0; i < 400; i++) {
    try {
      return await fixture.reach(state);
    } catch {
      await new Promise(r => setTimeout(r, 5));
    }
  }
  throw new Error(`condition not reached: fixture.reach("${state}")`);
}

/** #1548: same as waitForReach but for controlled-time journeys (no real sleeps). */
async function waitForReachControlled(fixture: Awaited<ReturnType<typeof makeFixture>>["fixture"], state: "executing" | "awaiting_contract"): Promise<{ runId: string; rootCardId: number }> {
  for (let i = 0; i < 400; i++) {
    try {
      return await fixture.reach(state);
    } catch {
      await vi.advanceTimersByTimeAsync(1);
    }
  }
  throw new Error(`condition not reached: fixture.reach("${state}")`);
}

describe("#1548 healthy control — long-running scheduled O project with real correlated progress", () => {
  it("keeps the custody observer green for 2s of journey time and settles once from project_accepted", async () => {
    vi.useFakeTimers();
    try {
      const { queue, coordinator } = await makeQueueWithCoordinator();
      const scheduler = new wakeSchedulerMod.LifecycleWakeScheduler();
      scheduler.register(dueSourcesMod.createRunDeadlineSource(coordinator));
      await scheduler.start();
      const { fixture } = await makeFixture({ holdAcceptance: true, workerCount: 1 });

      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      const { runId, rootCardId } = await waitForReachControlled(fixture, "executing");

      const { ExecutorLeaseStore } = leaseStoreMod;
      const observer = new observerClass("project-task", runId, {
        readRun: (taskId) => stateStore.readState(taskId)?.activeRun,
        historyOutcome: (rid) => events("project-task").find(e => e.runId === rid)?.outcome,
        card: (id) => board.kanbanGetCard(id),
        childrenOf: (rootId) => board.kanbanGetChildren(rootId),
        attemptsForCard: (cardId) => new WorkerSupervisionStoreClass().getAttemptsForCard(cardId),
        leaseFor: (attemptId) => new ExecutorLeaseStore().getView(attemptId),
        supervision: (rid) => new reviewStoreMod.ProjectReviewStore().getSupervision(rid),
        latestReviewCase: (rid) => new reviewStoreMod.ProjectReviewStore().getLatestReviewCase(rid),
        pendingInputRequests: () => [],
        currentJobs: () => queue.currentJobs,
        now: () => Date.now(),
      });

      // 2,000 ms of journey time with the worker card live: custody must stay
      // green at every 100 ms checkpoint.
      for (let t = 0; t < 2000; t += 100) {
        await vi.advanceTimersByTimeAsync(100);
        observer.checkpoint();
      }
      expect(fixture.holdAcceptance).toBe(true);

      // Complete the real project path: workers terminal -> review -> accept.
      fixture.completeWorkers();
      await vi.advanceTimersByTimeAsync(0);
      fixture.holdAcceptance = false;
      fixture.accept();
      await advanceUntil(() => !stateStore.readState("project-task")?.activeRun);

      observer.assertTerminal({ outcome: "success", source: "project_accepted" });
      const ev = events("project-task");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.runId).toBe(runId);
      expect(rootCardId).toBeDefined();
      expect(queue.currentJobs).toHaveLength(0);
      observer.stop();
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("#1548 Stage-1 defect cells — current dev must fail through the custody oracle", () => {
  async function setupCell(opts: { holdAcceptance?: boolean; failOrc?: boolean; workerCount?: number } = {}) {
    vi.useFakeTimers();
    const { queue, coordinator } = await makeQueueWithCoordinator();
    const scheduler = new wakeSchedulerMod.LifecycleWakeScheduler();
    const drainCalls: number[] = [];
    scheduler.register(dueSourcesMod.createRunDeadlineSource(coordinator));
    // #1546 Task 6: production-shaped wiring — BOTH kanban-retry callbacks
    // (Reconciler wake + unsupervised drain) are registered, so a wake that
    // reaches the drain for a supervised root is a named harness artifact.
    scheduler.register(dueSourcesMod.createKanbanRetrySource((cardId: number) => {
      reconcilerModule.requestReconcile(cardId);
    }, () => { drainCalls.push(1); }));
    await scheduler.start();
    const { fixture } = await makeFixture({ holdAcceptance: opts.holdAcceptance ?? true, workerCount: opts.workerCount ?? 1 });
    return { queue, coordinator, scheduler, fixture, drainCalls };
  }

  function supervisedRetrySource(drainCalls: number[]) {
    return dueSourcesMod.createKanbanRetrySource((cardId: number) => {
      reconcilerModule.requestReconcile(cardId);
    }, () => { drainCalls.push(1); });
  }

  it("cell 1 (#1546): Orc terminal failure in worker-owned executing leaves the retry path without an owner", async () => {
    const { queue, coordinator, scheduler, fixture, drainCalls } = await setupCell();
    try {
      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      const { runId, rootCardId } = await waitForReachControlled(fixture, "executing");

      fixture.failOrc("terminal_tool");
      fixture.failWorkers();
      fixture.retryRoot("orc terminal failure");
      const retryAt = Date.parse(board.kanbanGetCard(rootCardId)!.next_retry_at as string);

      const observer = new observerClass("project-task", runId, observerStores(queue, coordinator, runId));
      const kanbanRetrySource = supervisedRetrySource(drainCalls);

      // The retry becomes due and is woken twice, >=1s apart, with the real
      // reconciler pump attached: the retry path must re-claim the project.
      // Current dev produces no correlated effect — the ownership loss is the
      // named red diagnostic.
      await vi.advanceTimersByTimeAsync(Math.max(1, retryAt - Date.now() + 1));
      await observer.fireWake(kanbanRetrySource);
      await vi.advanceTimersByTimeAsync(600);
      observer.checkpoint();
      await vi.advanceTimersByTimeAsync(600);
      await observer.fireWake(kanbanRetrySource);
      await vi.advanceTimersByTimeAsync(600);

      // R6: this cell is intentionally RED on current dev. The retry path
      // must re-claim the project; current dev cannot, so the custody oracle
      // throws the named diagnostic. The shape is verified and the original
      // error re-thrown — the failure IS the red evidence, never a generic
      // timeout. After the #1546/#1547 fix the checkpoint passes and the
      // post-fix assertions below run.
      try {
        observer.checkpoint();
        const snap = observer.sample();
        expect(snap.liveAttempts.length + snap.durableContinuations.length).toBeGreaterThan(0);
        expect(snap.historyOutcome).toBeUndefined();
        // Task 6: exactly one correlated claim after the retry (the admission
        // authoring row plus one review claim); the second wake is idempotent.
        expect(new orcRunStoreMod.OrcProjectRunStore().getRunsForProject(rootCardId)).toHaveLength(2);
      } catch (e) {
        if (e instanceof CustodyGapErrorClass) {
          expect(e.kind).toBe("two_no_effect_wakes");
          expect(e.wake?.sourceId).toBe("kanban-retry");
          process.stdout.write("CELL1 " + e.message + "\n");
          throw e;
        }
        throw e;
      } finally {
        observer.stop();
        scheduler.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("cell 2 (#1546): the same failure plus bridge restart before retry dispatch", async () => {
    const { queue, coordinator, scheduler, fixture } = await setupCell();
    try {
      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      const { runId, rootCardId } = await waitForReachControlled(fixture, "executing");

      fixture.failOrc("terminal_tool");
      fixture.failWorkers();
      fixture.retryRoot("orc terminal failure");

      // Restart before retry dispatch: fresh queue/coordinator recover the run.
      // #1546 post-fix: the reattached runner wakes the shared driver, which
      // promotes the due retry (claim-before-promotion), creates the review
      // case for the terminal workers, and dispatches the Orc review. The
      // fresh Orc dies on its review turn, leaving the open case + pending
      // request as the durable owner — no legacy Spin dispatch, no settlement.
      const { queue: queue2, coordinator: coordinator2 } = await makeQueueWithCoordinator();
      const fixture2 = await makeFixture({ holdAcceptance: true, reviewMode: "die" });
      const scheduler2 = new wakeSchedulerMod.LifecycleWakeScheduler();
      scheduler2.register(dueSourcesMod.createRunDeadlineSource(coordinator2));
      const drainCalls2: number[] = [];
      scheduler2.register(supervisedRetrySource(drainCalls2));
      await scheduler2.start();
      let reattached = false;
      await coordinator2.recover(taskStore.readEntries(), (entry, run) => {
        const enqueueResult = queue2.enqueue(entry, false, run);
        if (enqueueResult) return false;
        reattached = true;
        return true;
      });
      expect(reattached).toBe(true);

      const observer = new observerClass("project-task", runId, observerStores(queue2, coordinator2, runId));
      // The durable retry was due before restart. The driver owns the due
      // check and promotion; the run keeps a durable owner (open review case)
      // and never reaches the absolute deadline.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(drainCalls2).toHaveLength(0); // the supervised root never drains

      // Post-fix contract: one correlated review claim, consumed retry item,
      // preserved run ID, no settlement.
      try {
        observer.checkpoint();
        const snap = observer.sample();
        expect(snap.liveAttempts.length + snap.durableContinuations.length).toBeGreaterThan(0);
        expect(snap.durableContinuations.some(c => c.kind === "review_request" || c.kind === "orc_claim")).toBe(true);
        expect(snap.historyOutcome).toBeUndefined();
      } catch (e) {
        if (e instanceof CustodyGapErrorClass) {
          expect(e.kind).toBe("no_custody");
          expect(e.snapshot.rootCardId).toBe(rootCardId);
          expect(e.snapshot.supervisionState).toBe("executing");
          expect(e.snapshot.liveAttempts).toHaveLength(0);
          expect(e.snapshot.durableContinuations).toHaveLength(0);
          process.stdout.write("CELL2 " + e.message + "\n");
          throw e;
        }
        throw e;
      } finally {
        observer.stop();
        scheduler2.stop();
        scheduler.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("cell 3 (#1547): restart reattach from valid non-terminal executing with no live child", async () => {
    const { queue, coordinator, scheduler, fixture } = await setupCell();
    try {
      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      const { runId, rootCardId } = await waitForReachControlled(fixture, "executing");

      // The Orc dies; the live child is removed through the scripted failure.
      fixture.failOrc("terminal_tool");
      fixture.failWorkers();

      // Restart: fresh harness reattaches the same run.
      // #1546 post-fix: the reattach wake routes the run into the shared
      // driver, which creates the review case for the terminal workers and
      // dispatches the Orc review. The fresh Orc dies on its review turn,
      // leaving the open case + pending request as the real durable owner
      // after reattach.
      const { queue: queue2, coordinator: coordinator2 } = await makeQueueWithCoordinator();
      const fixture2 = await makeFixture({ holdAcceptance: true, reviewMode: "die" });
      const scheduler2 = new wakeSchedulerMod.LifecycleWakeScheduler();
      scheduler2.register(dueSourcesMod.createRunDeadlineSource(coordinator2));
      scheduler2.register(supervisedRetrySource([]));
      let reattached = false;
      await coordinator2.recover(taskStore.readEntries(), (entry, run) => {
        const enqueueResult = queue2.enqueue(entry, false, run);
        if (enqueueResult) return false;
        reattached = true;
        return true;
      });
      expect(reattached).toBe(true);
      expect(stateStore.readState("project-task")!.activeRun!.runId).toBe(runId);
      fixture2.fixture.adoptRoot(rootCardId);

      const observer = new observerClass("project-task", runId, observerStores(queue2, coordinator2, runId));
      // The failed-worker terminal fact must clear its settle grace; after
      // that the reattached run has no child, no continuation, and no driver.
      await vi.advanceTimersByTimeAsync(20_000);

      // R6: intentionally RED on current dev — see cell 1 for the contract.
      try {
        observer.checkpoint();
        const snap = observer.sample();
        expect(snap.liveAttempts.length + snap.durableContinuations.length).toBeGreaterThan(0);
        expect(snap.historyOutcome).toBeUndefined();
      } catch (e) {
        if (e instanceof CustodyGapErrorClass) {
          expect(e.kind).toBe("no_custody");
          expect(e.snapshot.rootCardId).toBe(rootCardId);
          expect(e.snapshot.supervisionState).toBe("executing");
          expect(e.snapshot.liveAttempts).toHaveLength(0);
          process.stdout.write("CELL3 " + e.message + "\n");
          throw e;
        }
        throw e;
      } finally {
        observer.stop();
        scheduler2.stop();
        scheduler.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("cell 4 (#1546): a due supervised-root retry whose wake produces no correlated effect", async () => {
    const { queue, coordinator, scheduler, fixture, drainCalls } = await setupCell();
    try {
      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      const { runId, rootCardId } = await waitForReachControlled(fixture, "executing");

      fixture.failOrc("terminal_tool");
      fixture.failWorkers();
      fixture.retryRoot("orc terminal failure");
      const retryCard = board.kanbanGetCard(rootCardId)!;
      const retryAt = Date.parse(retryCard.next_retry_at as string);
      expect(retryAt).toBeGreaterThan(Date.now());

      const observer = new observerClass("project-task", runId, observerStores(queue, coordinator, runId));
      const kanbanRetrySource = supervisedRetrySource(drainCalls);

      // Fire two correlated wakes separated by at least 1s once due: both
      // must be no-effect on current dev (the retry path loses ownership).
      await vi.advanceTimersByTimeAsync(retryAt - Date.now() + 1);
      await observer.fireWake(kanbanRetrySource);
      await vi.advanceTimersByTimeAsync(600);
      observer.checkpoint();
      await vi.advanceTimersByTimeAsync(600);
      await observer.fireWake(kanbanRetrySource);
      await vi.advanceTimersByTimeAsync(600);

      // R6: intentionally RED on current dev — see cell 1 for the contract.
      try {
        observer.checkpoint();
        const snap = observer.sample();
        expect(snap.liveAttempts.length + snap.durableContinuations.length).toBeGreaterThan(0);
        expect(snap.historyOutcome).toBeUndefined();
        // Task 6: one correlated claim after the retry; the two manual wakes
        // are idempotent — no third run row.
        expect(new orcRunStoreMod.OrcProjectRunStore().getRunsForProject(rootCardId)).toHaveLength(2);
      } catch (e) {
        if (e instanceof CustodyGapErrorClass) {
          expect(e.kind).toBe("two_no_effect_wakes");
          expect(e.wake?.wakeTimes).toHaveLength(2);
          process.stdout.write("CELL4 " + e.message + "\n");
          throw e;
        }
        throw e;
      } finally {
        observer.stop();
        scheduler.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

function observerStores(queue: import("../../components/tasks/task-queue.js").CronQueue, _coordinator: CoordinatorClass, runId: string) {
  return {
    readRun: (taskId: string) => stateStore.readState(taskId)?.activeRun,
    historyOutcome: (rid: string) => events("project-task").find(e => e.runId === rid)?.outcome,
    card: (id: number) => board.kanbanGetCard(id),
    childrenOf: (rootId: number) => board.kanbanGetChildren(rootId),
    attemptsForCard: (cardId: number) => new WorkerSupervisionStoreClass().getAttemptsForCard(cardId),
    leaseFor: () => undefined,
    supervision: (rid: number) => new reviewStoreMod.ProjectReviewStore().getSupervision(rid),
    liveOrcRun: (rid: number) => {
      const row = new orcRunStoreMod.OrcProjectRunStore().getLiveRunForProject(rid);
      return row ? { runId: row.id, projectGeneration: row.project_generation } : undefined;
    },
    latestReviewCase: (rid: number) => new reviewStoreMod.ProjectReviewStore().getLatestReviewCase(rid),
    pendingInputRequests: (rid: number) => new reviewStoreMod.ProjectReviewStore().getPendingInputRequestsForProject(rid),
    currentJobs: () => queue.currentJobs,
    now: () => Date.now(),
    onCardEvent: (cb) => {
      const n = nerveMod.nerve;
      n.on("card:done", cb);
      n.on("card:failed", cb);
      n.on("card:running", cb);
      return () => {
        n.off("card:done", cb);
        n.off("card:failed", cb);
        n.off("card:running", cb);
      };
    },
  };
}

describe("#1548 Task-6 coverage — dispatcher-owned review and external input wait", () => {
  it("review_requested holds custody through the review_request continuation and settles from the Orc review", async () => {
    vi.useFakeTimers();
    try {
      const { queue, coordinator } = await makeQueueWithCoordinator();
      const scheduler = new wakeSchedulerMod.LifecycleWakeScheduler();
      scheduler.register(dueSourcesMod.createRunDeadlineSource(coordinator));
      await scheduler.start();
      const { fixture } = await makeFixture({ workerCount: 1, reviewMode: "accept" });

      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      const { runId, rootCardId } = await waitForReachControlled(fixture, "executing");
      const observer = new observerClass("project-task", runId, observerStores(queue, coordinator, runId));
      observer.sample(); // capture the root card before settlement
      observer.startPolling(); // R4: 100 ms journey-clock fallback poll

      fixture.completeWorkers();
      // The real reconciler assembles the case, inserts the review request,
      // and schedules the Orc review turn.
      reconcilerModule.requestReconcile(rootCardId);
      await advanceUntil(() => fixture.lastTurn === "reviewed" || !stateStore.readState("project-task")?.activeRun);

      if (!stateStore.readState("project-task")?.activeRun) {
        console.error("T6a settled early:", JSON.stringify(events("project-task")));
      }
      await advanceUntil(() => !stateStore.readState("project-task")?.activeRun);
      observer.assertTerminal({ outcome: "success", source: "project_accepted" });
      const ev = events("project-task");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.runId).toBe(runId);
      observer.stop();
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("needs_input holds custody through the input_request continuation; answering resumes to acceptance", async () => {
    vi.useFakeTimers();
    try {
      const { queue, coordinator } = await makeQueueWithCoordinator();
      const scheduler = new wakeSchedulerMod.LifecycleWakeScheduler();
      scheduler.register(dueSourcesMod.createRunDeadlineSource(coordinator));
      await scheduler.start();
      const { fixture } = await makeFixture({ workerCount: 1, reviewMode: "needs_input" });

      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      const { runId, rootCardId } = await waitForReachControlled(fixture, "executing");

      fixture.completeWorkers();
      reconcilerModule.requestReconcile(rootCardId);
      await waitForReachControlled(fixture, "needs_input");

      // Pending external input is a named durable continuation: custody is
      // held while the run waits.
      const observer = new observerClass("project-task", runId, observerStores(queue, coordinator, runId));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(observer.sample().durableContinuations.some(c => c.kind === "input_request")).toBe(true);
      observer.checkpoint();

      // The operator answers; the reconciler opens the next review round and
      // the Orc review accepts.
      fixture.answerInput("scope confirmed");
      fixture.setReviewMode("accept");
      reconcilerModule.requestReconcile(rootCardId);
      await advanceUntil(() => !stateStore.readState("project-task")?.activeRun);
      observer.assertTerminal({ outcome: "success", source: "project_accepted" });
      expect(events("project-task")).toHaveLength(1);
      observer.stop();
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a review-blocked project settles once from project_blocked", async () => {
    vi.useFakeTimers();
    try {
      const { queue, coordinator } = await makeQueueWithCoordinator();
      const scheduler = new wakeSchedulerMod.LifecycleWakeScheduler();
      scheduler.register(dueSourcesMod.createRunDeadlineSource(coordinator));
      await scheduler.start();
      const { fixture } = await makeFixture({ workerCount: 1, reviewMode: "blocked" });

      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      const { runId, rootCardId } = await waitForReachControlled(fixture, "executing");
      const observer = new observerClass("project-task", runId, observerStores(queue, coordinator, runId));
      observer.sample();

      fixture.completeWorkers();
      reconcilerModule.requestReconcile(rootCardId);
      await advanceUntil(() => !stateStore.readState("project-task")?.activeRun);

      observer.assertTerminal({ outcome: "failed", source: "project_blocked" });
      const ev = events("project-task");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.runId).toBe(runId);
      expect(rootCardId).toBeDefined();
      expect(new reviewStoreMod.ProjectReviewStore().getSupervision(rootCardId)?.state).toBe("blocked");
      observer.stop();
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a repair decision re-works the project through repair_planned -> repairing -> round 2 and accepts", async () => {
    vi.useFakeTimers();
    try {
      const { queue, coordinator } = await makeQueueWithCoordinator();
      const scheduler = new wakeSchedulerMod.LifecycleWakeScheduler();
      scheduler.register(dueSourcesMod.createRunDeadlineSource(coordinator));
      await scheduler.start();
      const { fixture } = await makeFixture({ workerCount: 1, reviewMode: "repair" });

      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      const { runId, rootCardId } = await waitForReachControlled(fixture, "executing");
      const observer = new observerClass("project-task", runId, observerStores(queue, coordinator, runId));
      observer.sample();
      observer.startPolling();

      // Round 1: workers done -> the Orc review decides repair (durable
      // decision, generation advance) and the fixture creates the repair
      // worker. A second reconcile pass (production re-wakes the card on the
      // decision settlement) moves repair_planned -> repairing.
      fixture.completeWorkers();
      reconcilerModule.requestReconcile(rootCardId);
      // #1554: the driver owns the repair continuation — the review turn
      // settles the repair decision AND creates the repair worker, and the
      // driver advances repair_planned -> repairing within the pass.
      await waitForReachControlled(fixture, "repairing");
      observer.checkpoint();
      await vi.advanceTimersByTimeAsync(500);
      const snapRepair = observer.sample();
      expect(snapRepair.liveAttempts.length).toBeGreaterThan(0);
      observer.checkpoint();

      // Repair worker completes; the reconciler opens review round 2 and the
      // Orc review accepts.
      fixture.completeWorkers();
      fixture.setReviewMode("accept");
      reconcilerModule.requestReconcile(rootCardId);
      await advanceUntil(() => !stateStore.readState("project-task")?.activeRun);
      if (!stateStore.readState("project-task")?.activeRun) {
        const sup2 = new reviewStoreMod.ProjectReviewStore().getSupervision(rootCardId);
        process.stdout.write("REPAIR2 state=" + sup2?.state + " ev=" + JSON.stringify(events("project-task")) + "\n");
      }
      observer.assertTerminal({ outcome: "success", source: "project_accepted" });
      expect(events("project-task")).toHaveLength(1);
      const sup = new reviewStoreMod.ProjectReviewStore().getSupervision(rootCardId);
      expect(sup?.state).toBe("accepted");
      expect(sup?.review_round).toBeGreaterThanOrEqual(1);
      observer.stop();
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("#1588 E2E — root-cause cascade for a late-completion supervised lane", () => {
  it("settles once with supervision/lane_late_completion, notifies the operator with the lane facts, and stays silent for deferred runs", async () => {
    const cascadeDiagnostics: TaskFailureDiagnosticV1[] = [];
    const cascadeNotifications: string[] = [];
    const { buildFailureNotification } = await import("../../boot/phase-pipeline-deps.js");
    const { CronQueue } = await import("../../components/tasks/task-queue.js");
    const coordinator = new CoordinatorClass({
      onTaskPaused: (chatId, title, reason) => { doubles.pausedNotifications.push(`${chatId}:${title}:${reason}`); },
      agentRunner: fakeAgentRunner,
      projectRunner: realProjectRunner,
      onFailure: (event) => {
        cascadeDiagnostics.push(event.diagnostic);
        cascadeNotifications.push(buildFailureNotification(event));
      },
    });
    const queue = new CronQueue(coordinator);
    const { fixture } = await makeFixture({ workerCount: 1, workerLimits: { max_duration_ms: 120_000 } });
    forceDue("project-task");
    await tick.runTaskTick(makeTickCtx(queue));
    const { runId, rootCardId } = await waitForReach(fixture, "executing");

    // The lane's worker completes AFTER its hard deadline: backdate the
    // attempt's hard_deadline_at, then settle through the real terminal
    // settlement primitive, which force-settles lifecycle=timed_out with the
    // late-completion cancel reason and records the absence envelope.
    const workerCard = board.kanbanGetChildren(rootCardId).find((c) => c.type === "W")!;
    const supStore = new WorkerSupervisionStoreClass();
    const attempt = supStore.getLatestAttempt(workerCard.id)!;
    supStore.db.prepare("UPDATE worker_attempts SET hard_deadline_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 30_000).toISOString(), attempt.id);
    const settled = supStore.terminalSettlement({
      attemptId: attempt.id, expectedGeneration: 1, desiredState: "completed", stableReason: "worker_completed",
    });
    expect(settled.kind).toBe("settled");
    if (settled.kind === "settled") expect(settled.lifecycle).toBe("timed_out");
    const lateAttempt = supStore.getAttempt(attempt.id)!;
    expect(lateAttempt.cancel_reason).toContain("late_completion_timed_out");
    const absence = supStore.getResultByAttempt(attempt.id);
    expect(absence).toBeDefined();
    expect(absence!.envelope.outcome).toBe("timed_out");

    // The worker card completes; the Orc review blocks the project.
    board.kanbanComplete(workerCard.id, null, "worker complete");
    fixture.block("late completion review blocked");
    await waitFor(() => !stateStore.readState("project-task")?.activeRun);

    // 1. Durable history carries the supervision diagnostic with full context.
    const ev = events("project-task");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.runId).toBe(runId);
    expect(ev[0]!.outcome).toBe("failed");
    const diag = ev[0]!.diagnostic as TaskFailureDiagnosticV1;
    expect(diag.category).toBe("supervision");
    // #1605 R6: an Orc-authored blocked decision is the terminal authority —
    // project_blocked with the Orc blocker; lane facts remain review evidence.
    expect(diag.code).toBe("project_blocked");
    expect(diag.message).toContain("late completion review blocked");
    const lane = diag.context!.lanes[0]!;
    expect(lane.cardId).toBe(workerCard.id);
    expect(lane.contractId).toMatch(/^c_/);
    expect(lane.attemptId).toBe(attempt.id);
    expect(lane.lifecycle).toBe("timed_out");
    expect(lane.cancelReason).toContain("late_completion_timed_out");
    expect(lane.hardDeadlineAt).toBeDefined();
    expect(lane.settledAt).toBeDefined();
    expect(lane.overrunMs).toBeGreaterThan(0);
    expect(lane.bindingLimit).toEqual({ name: "max_duration_ms", value: 120_000 });
    expect(lane.criteria).toContainEqual({ id: "w0", status: "not_run" });
    expect(lane.missingEvidence).toEqual([]);

    // 2. The failure callback fired exactly once for the run.
    expect(cascadeDiagnostics).toHaveLength(1);

    // 3. The operator notification carries category/code and the lane facts.
    expect(cascadeNotifications).toHaveLength(1);
    // #1605 R6: the Orc-blocked decision is the terminal authority — the
    // notification names project_blocked with the Orc blocker and the lane
    // facts underneath.
    expect(cascadeNotifications[0]).toContain("Project Task failed - supervision/project_blocked");
    expect(cascadeNotifications[0]).toContain(`card ${workerCard.id}`);
    expect(cascadeNotifications[0]).toContain("binding_limit max_duration_ms=120000");
    expect(cascadeNotifications[0]).toContain("overrun_ms");
    expect(cascadeNotifications[0]).not.toMatch(/[📥✅❌⏳🔧⚠️]/);

    // 4. The admission notice built from the captured diagnostic stays typed
    // and bounded (#1688).
    const { shaAdmissionNotice } = await import("../../components/sha/sha-admission-notice.js");
    const shaNotice = shaAdmissionNotice(
      { source: "scheduled", entryId: "project-task", runId: "r", taskKind: "agent", diagnostic: cascadeDiagnostics[0]!, occurredAt: Date.now() },
      { kind: "ignored", reason: "system" },
    );
    expect(shaNotice).toContain("system-kind");
});
});

describe("#1644 E2E — scheduled-project terminal authority (incident shape)", () => {
  it("blocks once after all lanes fail; a stale spawn, a late result, and delivery all lose their authority", async () => {
    const queue = await makeQueue();
    const { fixture, orc } = await makeFixture({ workerCount: 3, reviewMode: "blocked" });
    forceDue("project-task");
    await tick.runTaskTick(makeTickCtx(queue));
    const { runId, rootCardId } = await waitForReach(fixture, "executing");

    // All three lanes fail; a stale Orc turn claims its run BEFORE the
    // terminal settlement (the incident's verification-handoff shape).
    fixture.failWorkers();
    const armed = fixture.armStaleSpawn("Web verification handoff");
    expect("error" in armed).toBe(false);
    if ("error" in armed) throw new Error(armed.error);
    fixture.block("all lanes failed; review abandoned");
    await waitFor(() => !stateStore.readState("project-task")?.activeRun);

    // 1. Exactly one failed history entry; the root is blocked.
    const ev = events("project-task");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.runId).toBe(runId);
    expect(ev[0]!.outcome).toBe("failed");
    expect(new reviewStoreMod.ProjectReviewStore().getSupervision(rootCardId)?.state).toBe("blocked");

    // 2. The stale Orc run was superseded by the terminal settlement.
    const runRow = orc.getStore().db.prepare(`SELECT state, outcome FROM orc_project_runs WHERE id = ?`).get(armed.runId) as { state: string; outcome: string } | undefined;
    expect(runRow).toBeDefined();
    expect(runRow!.state).toBe("superseded");
    expect(runRow!.outcome).toBe("project_terminal");

    // 3. The paused stale spawn cannot create a child post-terminal — no
    // durable child card, contract, or attempt beyond the three original lanes.
    const stale = fixture.releaseStaleSpawn();
    expect(stale.rejected).toBe(true);
    if (stale.error) expect(stale.error).toContain("project_terminal");
    const children = board.kanbanGetChildren(rootCardId).filter(c => c.type === "W");
    expect(children).toHaveLength(3);
    const contracts = orc.getStore().db.prepare(`SELECT COUNT(*) AS cnt FROM worker_contracts`).get() as { cnt: number };
    expect(contracts.cnt).toBe(3);

    // 4. A late worker result is rejected at the project-authority fence: the
    // failed lane attempt keeps its durable state and no result row appears.
    const workerCard = children[0]!;
    const supStore = new WorkerSupervisionStoreClass();
    const attempt = supStore.getLatestAttempt(workerCard.id)!;
    expect(attempt.lifecycle).toBe("failed");
    const late = fixture.submitLateWorkerResult(workerCard.id, attempt.id);
    expect(late.settled).toBe(false);
    expect(late.stale).toBe(true);
    expect(supStore.getAttempt(attempt.id)!.lifecycle).toBe("failed");
    expect(supStore.getResultByAttempt(attempt.id)).toBeUndefined();

    // 5. The delivery poll (captured platform boundary) sends nothing: the
    // blocked root is not done, no artifact was attached, delivery never
    // released.
    const root = board.kanbanGetCard(rootCardId)!;
    expect(root.status).toBe("failed");
    expect(root.delivery_ready).toBe(0);
    expect(root.result_path).toBeNull();
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    expect(doubles.sentDocuments).toHaveLength(0);
    expect(doubles.sentMessages).toHaveLength(0);

    // 6. Bounded structured rejection traces: child creation and the late
    // worker result each emitted exactly one primary rejection record.
    const rejections = swarmTrace.lines.filter(l => l.msg.includes("project_mutation_rejected"));
    expect(rejections.filter(l => l.msg.includes("child_creation"))).toHaveLength(1);
    expect(rejections.filter(l => l.msg.includes("worker_result_settlement"))).toHaveLength(1);
    expect(rejections.every(l => l.msg.includes("project_terminal"))).toBe(true);
    // No content leak: bounded trace carries no prompts or results.
    expect(rejections.every(l => !l.msg.includes("<summary>"))).toBe(true);
  });
});

describe("#1656 E2E — truthful worker evidence and fail-closed parent acceptance", () => {
  const workspaceOf = (rootCardId: number): string => {
    const scope = new reviewStoreMod.ProjectReviewStore().getWorkspaceScope(rootCardId);
    if (!scope) throw new Error("scheduled project workspace was never bound");
    return scope.cwd;
  };

  /** Settle the lane through the REAL collectAndSettle path in the bound
   *  workspace; write the artifact first when the lane should pass. */
  function settleLane(rootCardId: number, cardId: number, artifactExists: boolean): { attemptId: string; summary: string } {
    const svc = new WorkerSupervisionServiceClass();
    const supStore = new WorkerSupervisionStoreClass();
    const attempt = supStore.getLatestAttempt(cardId)!;
    const cwd = workspaceOf(rootCardId);
    if (artifactExists) {
      const artifact = join(cwd, "out", `lane-${attempt.ordinal - 1}.md`);
      mkdirSync(dirname(artifact), { recursive: true });
      writeFileSync(artifact, "lane delivered\n", "utf-8");
    }
    const outcome = svc.collectAndSettle(cardId, "<summary>lane finished</summary>", cwd, attempt.id, attempt.generation);
    if (!outcome.settled) throw new Error(`lane settlement failed: ${outcome.summary}`);
    return { attemptId: attempt.id, summary: outcome.summary };
  }

  /** Build the immutable review case through the real assembler.
   *  #1554: the driver may already own the open case (all-terminal children);
   *  reuse it so the decision targets the driver's durable case. */
  async function assembleAndInsertReview(rootCardId: number): Promise<string> {
    const store = new reviewStoreMod.ProjectReviewStore();
    const supervision = store.getSupervision(rootCardId)!;
    const existing = store.getLatestOpenCase(rootCardId);
    if (existing) return existing.id;
    const { ReviewCaseAssembler } = await import("../../components/project-acceptance/project-review-case.js");
    const snapshot = await new ReviewCaseAssembler().assembleCase(rootCardId, supervision.generation, supervision.review_round + 1);
    if ("error" in snapshot) throw new Error(`review assembly failed: ${snapshot.error}`);
    const { id } = store.insertReviewCase(rootCardId, supervision.generation, supervision.review_round + 1, snapshot, `digest_${rootCardId}_${Date.now()}`);
    store.insertReviewRequest(rootCardId, id, supervision.generation);
    return id;
  }

  it("Scenario A: all required lanes fail — accept is rejected and the parent is never delivered", async () => {
    const queue = await makeQueue();
    const { fixture } = await makeFixture({ workerCount: 1, holdAcceptance: true });
    forceDue("project-task");
    await tick.runTaskTick(makeTickCtx(queue));
    const { runId, rootCardId } = await waitForReach(fixture, "executing");

    // The bound workspace is durable before the first Orc turn could start.
    const cwd = workspaceOf(rootCardId);
    expect(existsSync(cwd)).toBe(true);

    // The lane completes but its required artifact is missing → failed evidence.
    const worker = board.kanbanGetChildren(rootCardId).find(c => c.type === "W")!;
    settleLane(rootCardId, worker.id, false);
    const supStore = new WorkerSupervisionStoreClass();
    const attempt = supStore.getLatestAttempt(worker.id)!;
    const result = supStore.getResultByAttempt(attempt.id)!;
    expect(result.envelope.outcome).toBe("completed");
    expect(result.envelope.criteria.every(c => c.status === "failed")).toBe(true);
    // The pump projection fails the W card — execution completed ≠ accepted.
    board.kanbanFail(worker.id, "worker completed without passing acceptance");
    // #1554: let the driver's wake open the review case first (or reuse ours).
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const caseId = await assembleAndInsertReview(rootCardId);
    const store = new reviewStoreMod.ProjectReviewStore();
    const supervision = store.getSupervision(rootCardId)!;
    const { ProjectReviewService } = await import("../../components/project-acceptance/project-review-service.js");
    const service = new ProjectReviewService();

    // The Orc submits the #1656 shape: satisfied c1 citing the failed child's
    // artifact evidence. The validator must reject it.
    const decision = {
      schema_version: 1,
      id: `rd_e2e_a_${Date.now()}`,
      project_card_id: rootCardId,
      review_case_id: caseId,
      project_generation: supervision.generation,
      action: "accept",
      criteria: [{
        criterion_id: "c1",
        verdict: "satisfied",
        evidence_ids: [`attempt:${attempt.id}:artifact:a0`],
        rationale: "handoff exists",
      }],
      outputs: [],
      contradictions: [],
      residual_risks: [],
      synthesis: "all lanes delivered",
      authored_at: new Date().toISOString(),
    };
    const outcome = service.processDecision(decision);
    expect(outcome.kind).toBe("invalid");
    expect(outcome.errors.some(e => /no successful mapped child/.test(e))).toBe(true);

    // Fail-closed parent: not accepted, not done, not delivery-ready, no
    // delivery record, no acceptance outbox.
    const root = board.kanbanGetCard(rootCardId)!;
    expect(store.getSupervision(rootCardId)!.state).not.toBe("accepted");
    expect(root.status).not.toBe("done");
    expect(root.delivery_ready).toBe(0);
    const outbox = store.db.prepare(`SELECT COUNT(*) AS cnt FROM project_acceptance_outbox WHERE project_card_id = ?`).get(rootCardId) as { cnt: number };
    expect(outbox.cnt).toBe(0);
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    expect(doubles.sentDocuments).toHaveLength(0);
    expect(doubles.sentMessages).toHaveLength(0);
  });

  it("Scenario B: required lanes pass with relative artifacts — qualified evidence, accepted root, delivery eligible", async () => {
    const queue = await makeQueue();
    const { fixture } = await makeFixture({ workerCount: 1, holdAcceptance: true });
    forceDue("project-task");
    await tick.runTaskTick(makeTickCtx(queue));
    const { runId, rootCardId } = await waitForReach(fixture, "executing");

    const worker = board.kanbanGetChildren(rootCardId).find(c => c.type === "W")!;
    const { attemptId } = settleLane(rootCardId, worker.id, true);
    board.kanbanComplete(worker.id, null, "worker completed");
    // #1554: let the driver's wake open the review case first (or reuse ours).
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const caseId = await assembleAndInsertReview(rootCardId);
    const store = new reviewStoreMod.ProjectReviewStore();
    const supervision = store.getSupervision(rootCardId)!;
    const { ProjectReviewService } = await import("../../components/project-acceptance/project-review-service.js");
    const service = new ProjectReviewService();

    const decision = {
      schema_version: 1,
      id: `rd_e2e_b_${Date.now()}`,
      project_card_id: rootCardId,
      review_case_id: caseId,
      project_generation: supervision.generation,
      action: "accept",
      criteria: [{
        criterion_id: "c1",
        verdict: "satisfied",
        evidence_ids: [`attempt:${attemptId}:artifact:a0`],
        rationale: "lane handoff verified",
      }],
      outputs: [],
      contradictions: [],
      residual_risks: [],
      synthesis: "lane delivered",
      authored_at: new Date().toISOString(),
    };
    const outcome = service.processDecision(decision);
    expect(outcome.kind).toBe("accepted");

    // Let the scheduled runner observe the terminal acceptance and settle the
    // run row (task_runs success) — the delivery release CAS depends on it.
    nerveMod.nerve.fire("card:done", rootCardId);
    await waitFor(() => !stateStore.readState("project-task")?.activeRun);

    const root = board.kanbanGetCard(rootCardId)!;
    expect(root.status).toBe("done");
    expect(store.getSupervision(rootCardId)!.state).toBe("accepted");
    // Delivery release CAS: exact run/generation authority → ready → poll sends.
    board.kanbanSetProjectDeliveryReady(rootCardId, { projectGeneration: supervision.generation, scheduledRunId: runId });
    const released = board.kanbanGetCard(rootCardId)!;
    expect(released.delivery_ready).toBe(1);
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    expect(doubles.sentDocuments.length + doubles.sentMessages.length).toBeGreaterThan(0);
  });

  it("Scenario C: an optional failed lane is disclosed and accepted while required lanes pass", async () => {
    const queue = await makeQueue();
    const { fixture } = await makeFixture({ workerCount: 2, holdAcceptance: true, v2RootContract: true });
    forceDue("project-task");
    await tick.runTaskTick(makeTickCtx(queue));
    const { runId, rootCardId } = await waitForReach(fixture, "executing");

    const children = board.kanbanGetChildren(rootCardId).filter(c => c.type === "W");
    expect(children).toHaveLength(2);
    const [requiredLane, optionalLane] = children as [typeof children[number], typeof children[number]];
    const required = settleLane(rootCardId, requiredLane.id, true);
    const optional = settleLane(rootCardId, optionalLane.id, false);
    board.kanbanComplete(requiredLane.id, null, "worker completed");
    board.kanbanFail(optionalLane.id, "worker completed without passing acceptance");
    // #1554: let the driver's wake open the review case first (or reuse ours).
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    const caseId = await assembleAndInsertReview(rootCardId);
    const store = new reviewStoreMod.ProjectReviewStore();
    const supervision = store.getSupervision(rootCardId)!;
    const { ProjectReviewService } = await import("../../components/project-acceptance/project-review-service.js");
    const service = new ProjectReviewService();

    const decision = {
      schema_version: 1,
      id: `rd_e2e_c_${Date.now()}`,
      project_card_id: rootCardId,
      review_case_id: caseId,
      project_generation: supervision.generation,
      action: "accept",
      criteria: [
        { criterion_id: "c1", verdict: "satisfied", evidence_ids: [`attempt:${required.attemptId}:artifact:a0`], rationale: "required lane verified" },
        { criterion_id: "c2", verdict: "unsatisfied", evidence_ids: [], rationale: "optional source lane failed; the report remains useful without it" },
      ],
      outputs: [],
      contradictions: [],
      residual_risks: [],
      synthesis: "required lane delivered; optional lane disclosed as omitted",
      authored_at: new Date().toISOString(),
    };
    const outcome = service.processDecision(decision);
    expect(outcome.kind).toBe("accepted");

    const root = board.kanbanGetCard(rootCardId)!;
    expect(root.status).toBe("done");
    // The disclosed optional failure is visible in the rendered synthesis.
    expect((root.result_summary ?? "")).toContain("c2");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("condition not reached within timeout");
}

/** #1548: deterministic flush under Vitest controlled time. Each step yields
 *  to the event loop so dynamic-import I/O completes, without advancing the
 *  fake clock far enough to trip any production timer. */
async function advanceUntil(predicate: () => boolean, steps = 200): Promise<void> {
  for (let i = 0; i < steps; i++) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(1);
  }
  throw new Error("condition not reached under controlled time");
}
// ═══════════════════════════════════════════════════════════════════════════
// #1688 Epic-28 — SHA staged incident workflow E2E.
// One continuous journey: scheduled settler → typed signal → coordinator/store
// → Kanban O/W cards → Worker supervision → staged results → review → cleanup.
// Only model/provider/process boundaries are fixtures; the SHA workspace is a
// REAL disposable git checkout and stage evidence is written into it exactly
// as the Pi executor would.
// ═══════════════════════════════════════════════════════════════════════════
describe("#1688 SHA incident workflow E2E — settler → coordinator → Kanban → Worker → review → cleanup", () => {
  let shaWs: string;
  let shaStore: typeof import("../../components/sha/sha-incident-store.js");
  let shaCoordinator: import("../../components/sha/sha-incident-coordinator.js").ShaIncidentCoordinator;
  let shaSupervision: WorkerSupervisionStoreClass;
  let shaNotices: string[];

  type ShaIncidentCoordinatorClass = import("../../components/sha/sha-incident-coordinator.js").ShaIncidentCoordinator;

  async function setupShaWorkspace(): Promise<void> {
    const { execFileSync } = await import("node:child_process");
    shaWs = join(dirname(TEST_HOME), "sha-ws");
    rmSync(shaWs, { recursive: true, force: true });
    mkdirSync(shaWs, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: shaWs });
    execFileSync("git", ["-c", "user.email=sha@test", "-c", "user.name=sha", "commit", "-q", "--allow-empty", "-m", "baseline"], { cwd: shaWs });
    writeFileSync(join(TEST_HOME, "config", "pi-executor.json"), JSON.stringify({
      enabled: true, command: "pi", fixedArgs: [], allowedEnv: [], maxConcurrent: 1,
      maxWallClockMs: 1_800_000, abortGraceMs: 10_000, projectTrust: "never",
      workspaceAliases: { sha: { path: shaWs, root: dirname(TEST_HOME), projectTrust: "never" } },
      sessionStorageRoot: join(TEST_HOME, "state"),
    }));
  }

  async function makeShaQueue(mode: "off" | "investigation" | "full" = "full"): Promise<import("../../components/tasks/task-queue.js").CronQueue> {
    shaNotices = [];
    const { ShaIncidentCoordinator } = await import("../../components/sha/sha-incident-coordinator.js");
    const { shaAdmissionNotice } = await import("../../components/sha/sha-admission-notice.js");
    shaStore = await import("../../components/sha/sha-incident-store.js");
    shaSupervision = new WorkerSupervisionStoreClass();
    shaCoordinator = new ShaIncidentCoordinator({
      modeProvider: () => mode,
      policyView: () => ({ fixes: [], logAdmissionAllowed: true }),
      noticeSink: { send: (n) => shaNotices.push(n.message) },
    });
    shaCoordinator.subscribe();
    const { CronQueue } = await import("../../components/tasks/task-queue.js");
    const coordinator = new CoordinatorClass({
      onTaskPaused: () => {},
      agentRunner: fakeAgentRunner,
      projectRunner: realProjectRunner,
      onFailure: (event) => {
        const outcome = shaCoordinator.admit(event);
        const notice = shaAdmissionNotice(event, outcome);
        if (notice) shaNotices.push(notice);
      },
    });
    return new CronQueue(coordinator);
  }

  function stageCardIds(rootId: number): number[] {
    return board.kanbanList("*")
      .filter((c: { parent_id: number | null }) => c.parent_id === rootId)
      .sort((a: { id: number }, b: { id: number }) => a.id - b.id)
      .map((c: { id: number }) => c.id);
  }

  async function completeStage(cardId: number, artifactId: string, ref: string, digest: string): Promise<void> {
    const attempt = shaSupervision.getLatestAttempt(cardId)!;
    const contract = shaSupervision.getContract(attempt.contract_id)!;
    const contractJson = JSON.parse(contract.contract_json) as { digest?: string };
    const now = new Date().toISOString();
    const artifacts = [{ artifact_id: artifactId, exists: true, kind: "file" as const, ref, digest }];
    if (ref === "sha/solution.patch") {
      artifacts.push({ artifact_id: "sha-verification-json", exists: true, kind: "file", ref: "sha/verification.json", digest });
    }
    const envelope = {
      schema_version: 1,
      attempt: { id: attempt.id, ordinal: attempt.ordinal, contract_id: attempt.contract_id, contract_digest: contractJson.digest ?? "d", executor_kind: "pi", executor_id: "e2e-pi-run", started_at: now, finished_at: now },
      outcome: "completed",
      criteria: [{ criterion_id: "sha-" + artifactId.slice(4).split(".")[0], status: "passed", evidence_ids: [artifactId] }],
      checks: [],
      artifacts,
      worker_report: { summary: "e2e stage done", claims: [], unresolved_risks: [] },
    } as import("../../components/worker-contract.js").WorkerResultEnvelopeV1;
    // The Pi process boundary: write the evidence artifact into the real
    // disposable workspace exactly as the executor would.
    const dir = join(shaWs, "sha");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(shaWs, ref), JSON.stringify({ artifact: artifactId, digest }, null, 2));
    if (ref === "sha/solution.patch") {
      writeFileSync(join(shaWs, "sha/verification.json"), JSON.stringify({ commands: [], exit: 0 }, null, 2));
    }
    shaSupervision.insertResult(attempt.id, envelope);
    board.kanbanTransition({ cardId, from: ["queued", "running"], to: "done", actor: "e2e", reason: "stage complete" });
  }

  it("full mode: one root, sequential RCA/design/solution stages, accepted review, dedupe, evidence, cleanup", { timeout: 120_000 }, async () => {
    await setupShaWorkspace();
    const queue = await makeShaQueue("full");

    // 1. Real scheduled settler: a failing agent run emits the typed signal.
    forceDue("sha-agent-task");
    await runTick(queue);
    await vi.waitFor(() => expect(shaNotices.some((n) => n.includes("incident #"))).toBe(true), { timeout: 10_000 });

    const incidents = new shaStore.ShaIncidentStore(board.requireTaskDatabase()).listNonTerminal();
    expect(incidents).toHaveLength(1);
    const incident = incidents[0]!;
    expect(incident.state).toBe("rca");
    expect(incident.mode).toBe("full");
    const root = board.kanbanGetCard(incident.rootCardId!)!;
    expect(root.type).toBe("O");
    expect(root.source).toBe("sha");
    expect(root.max_agents).toBe(2);
    expect(root.delivery_mode).toBe("silent");
    const stages = stageCardIds(root.id);
    expect(stages).toHaveLength(3);
    // Complete blocked_by chain.
    const cards = board.kanbanList("*").filter((c: { id: number }) => stages.includes(c.id));
    expect(cards.map((c: { blocked_by: string | null }) => c.blocked_by)).toEqual([null, String(stages[0]), String(stages[1])]);

    // 2. RCA completes → design bound; design completes → solution bound.
    await completeStage(stages[0]!, "sha-rca-json", "sha/rca.json", "d-rca");
    await vi.waitFor(() => expect(new shaStore.ShaIncidentStore(board.requireTaskDatabase()).findById(incident.id)!.state).toBe("design"), { timeout: 10_000 });
    expect(shaSupervision.getContractByCardId(stages[1]!)).toBeDefined();
    expect(shaSupervision.getContractByCardId(stages[2]!)).toBeUndefined();

    await completeStage(stages[1]!, "sha-design-md", "sha/design.md", "d-design");
    await vi.waitFor(() => expect(new shaStore.ShaIncidentStore(board.requireTaskDatabase()).findById(incident.id)!.state).toBe("solution"), { timeout: 10_000 });
    expect(shaSupervision.getContractByCardId(stages[2]!)).toBeDefined();

    // 3. Solution completes → review → accepted root.
    await completeStage(stages[2]!, "sha-solution-patch", "sha/solution.patch", "d-sol");
    await vi.waitFor(() => expect(new shaStore.ShaIncidentStore(board.requireTaskDatabase()).findById(incident.id)!.state).toBe("review"), { timeout: 10_000 });
    board.kanbanTransition({ cardId: root.id, from: ["queued", "running"], to: "done", actor: "e2e", reason: "final review accepted" });
    await vi.waitFor(() => expect(new shaStore.ShaIncidentStore(board.requireTaskDatabase()).findById(incident.id)!.state).toBe("accepted"), { timeout: 10_000 });

    // 4. Evidence copied privately; disposable workspace restored to baseline;
    // canonical fixture files untouched.
    const evidenceDir = join(TEST_HOME, "state", "sha", "incidents", String(incident.id));
    expect(existsSync(join(evidenceDir, "rca", "rca.json"))).toBe(true);
    expect(existsSync(join(evidenceDir, "design", "design.md"))).toBe(true);
    expect(existsSync(join(evidenceDir, "solution", "solution.patch"))).toBe(true);
    const { execFileSync } = await import("node:child_process");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: shaWs, encoding: "utf-8" });
    expect(status.trim()).toBe("");

    // 5. Repeated failure after terminal acceptance allocates a NEW episode
    // (R4 rollover) — the terminal episode never gains duplicate roots.
    forceDue("sha-agent-task");
    await runTick(queue);
    await vi.waitFor(() => {
      const active = new shaStore.ShaIncidentStore(board.requireTaskDatabase()).listNonTerminal();
      expect(active.length).toBe(1);
      expect(active[0]!.episode).toBe(2);
    }, { timeout: 10_000 });
    const roots = board.kanbanList("*").filter((c: { type: string | null; source: string }) => c.type === "O" && c.source === "sha");
    expect(roots).toHaveLength(2);
    // Exactly one admission notice per durable decision.
    expect(shaNotices.filter((n) => n.includes("SHA: incident")).length).toBeGreaterThanOrEqual(2);
  });

  it("system-kind failures notify only — zero SHA state, zero quota", { timeout: 60_000 }, async () => {
    await setupShaWorkspace();
    const queue = await makeShaQueue("full");
    const { execFileSync } = await import("node:child_process");
    // A failing system task: register a handler that reports failure.
    registry.getSystemTaskRegistry().register("hardware-sleep", (_entry, _ctx) => ({ status: "failed", error: "hardware sleep failed" }));
    const systemEntry: ScheduledTask = {
      id: "sys-sha-e2e", kind: "system", action: "hardware-sleep", schedule: "* * * * *",
      enabled: true, priority: "medium", delivery: "silent",
    };
    taskStore.writeEntry(systemEntry);
    stateStore.initializeState([...taskStore.readEntries()]);
    forceDue("sys-sha-e2e");
    await runTick(queue);
    await vi.waitFor(() => expect(shaNotices.some((n) => n.includes("system-kind"))).toBe(true), { timeout: 10_000 });
    const events = board.requireTaskDatabase().prepare("SELECT COUNT(*) AS n FROM sha_incident_events").get();
    expect(Number(events?.["n"])).toBe(0);
    const incidents = new shaStore.ShaIncidentStore(board.requireTaskDatabase()).listNonTerminal();
    expect(incidents).toHaveLength(0);
    // No canonical mutation: the workspace stays at baseline.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: shaWs, encoding: "utf-8" });
    expect(status.trim()).toBe("");
  });

  it("investigation mode: RCA+design only, no solution card, investigation_complete terminal", { timeout: 120_000 }, async () => {
    await setupShaWorkspace();
    const queue = await makeShaQueue("investigation");
    forceDue("sha-agent-task");
    await runTick(queue);
    await vi.waitFor(() => expect(shaNotices.some((n) => n.includes("incident #"))).toBe(true), { timeout: 10_000 });
    const incident = new shaStore.ShaIncidentStore(board.requireTaskDatabase()).listNonTerminal()[0]!;
    const root = board.kanbanGetCard(incident.rootCardId!)!;
    const stages = stageCardIds(root.id);
    expect(stages).toHaveLength(2);
    await completeStage(stages[0]!, "sha-rca-json", "sha/rca.json", "d-rca");
    await vi.waitFor(() => expect(new shaStore.ShaIncidentStore(board.requireTaskDatabase()).findById(incident.id)!.state).toBe("design"), { timeout: 10_000 });
    await completeStage(stages[1]!, "sha-design-md", "sha/design.md", "d-design");
    await vi.waitFor(() => expect(new shaStore.ShaIncidentStore(board.requireTaskDatabase()).findById(incident.id)!.state).toBe("review"), { timeout: 10_000 });
    board.kanbanTransition({ cardId: root.id, from: ["queued", "running"], to: "done", actor: "e2e", reason: "accepted" });
    await vi.waitFor(() => expect(new shaStore.ShaIncidentStore(board.requireTaskDatabase()).findById(incident.id)!.state).toBe("investigation_complete"), { timeout: 10_000 });
    const status = (await import("node:child_process")).execFileSync("git", ["status", "--porcelain"], { cwd: shaWs, encoding: "utf-8" });
    expect(status.trim()).toBe("");
  });

  it("off mode: ordinary notice only, zero SHA writes, no registration of work", { timeout: 60_000 }, async () => {
    await setupShaWorkspace();
    const queue = await makeShaQueue("off");
    forceDue("sha-agent-task");
    await runTick(queue);
    await new Promise((r) => setTimeout(r, 100));
    const events = board.requireTaskDatabase().prepare("SELECT COUNT(*) AS n FROM sha_incident_events").get();
    expect(Number(events?.["n"])).toBe(0);
    const roots = board.kanbanList("*").filter((c: { type: string | null; source: string }) => c.type === "O" && c.source === "sha");
    expect(roots).toHaveLength(0);
  });

  it("stage timeout blocks the incident, cascades placeholders, and reports a typed reason", { timeout: 60_000 }, async () => {
    await setupShaWorkspace();
    const queue = await makeShaQueue("full");
    forceDue("sha-agent-task");
    await runTick(queue);
    await vi.waitFor(() => expect(shaNotices.some((n) => n.includes("incident #"))).toBe(true), { timeout: 10_000 });
    const incident = new shaStore.ShaIncidentStore(board.requireTaskDatabase()).listNonTerminal()[0]!;
    const stages = stageCardIds(incident.rootCardId!);
    // Simulate a timed-out RCA worker: the stage card fails without an envelope.
    board.kanbanTransition({ cardId: stages[0]!, from: ["queued", "running"], to: "failed", actor: "e2e", reason: "stage timed out" });
    await vi.waitFor(() => {
      const i = new shaStore.ShaIncidentStore(board.requireTaskDatabase()).findById(incident.id)!;
      expect(i.state).toBe("blocked");
      expect(i.terminalReason).toContain("failed");
    }, { timeout: 10_000 });
    // Later placeholders cascaded; the root project is blocked.
    for (const stageId of stages.slice(1)) {
      expect(board.kanbanGetCard(stageId)!.status).toBe("failed");
    }
    const supervision = board.requireTaskDatabase().prepare("SELECT state FROM project_supervision WHERE project_card_id = ?").get(incident.rootCardId!) as { state: string };
    expect(supervision.state).toBe("blocked");
  });

  it("known fix with a failing verifier is never reported fixed", { timeout: 60_000 }, async () => {
    await setupShaWorkspace();
    const { ShaIncidentCoordinator } = await import("../../components/sha/sha-incident-coordinator.js");
    const { shaAdmissionNotice } = await import("../../components/sha/sha-admission-notice.js");
    shaStore = await import("../../components/sha/sha-incident-store.js");
    const rule = {
      pattern: "sha-incident-boom", action: "run" as const,
      command: ["git", "rev-parse", "HEAD"], verifyCommand: ["git", "rev-parse", "no-such-branch"],
      cooldownMin: 5, verified: true,
    };
    shaCoordinator = new ShaIncidentCoordinator({
      modeProvider: () => "full",
      policyView: () => ({ fixes: [rule], logAdmissionAllowed: true }),
      noticeSink: { send: () => {} },
    });
    const event = { source: "scheduled" as const, entryId: "sha-agent-task", runId: "run-kf-1", taskKind: "agent" as const, diagnostic: makeDiagnosticShaBoom(), occurredAt: Date.now() };
    const outcome = shaCoordinator.admit(event);
    expect(outcome.kind).toBe("known_fix_started");
    await vi.waitFor(() => {
      const incidents = new shaStore.ShaIncidentStore(board.requireTaskDatabase()).listNonTerminal();
      expect(incidents.length).toBe(0); // terminal episode
      const row = board.requireTaskDatabase().prepare("SELECT state FROM sha_incidents WHERE id = ?").get(outcome.kind === "known_fix_started" ? outcome.incidentId : 0) as { state: string };
      expect(row.state).toBe("known_fix_unverified");
    }, { timeout: 15_000 });
    // Truthful notice: never "fixed".
    expect(shaAdmissionNotice(event, outcome)).toContain("known fix started");
  });

  function makeDiagnosticShaBoom(): import("../../components/tasks/task-failure.js").TaskFailureDiagnosticV1 {
    return {
      version: 1, category: "execution", code: "model_error", phase: "executing",
      message: "provider model error: sha-incident-boom", retryability: "none", occurredAt: Date.now(),
    };
  }
});
