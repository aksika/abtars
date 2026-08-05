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
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

let TEST_HOME: string;

vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME, abmindHome: () => join(TEST_HOME, "..", "abmind-test") }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});
import * as child_process from "node:child_process";

import type { ScheduledTask } from "../../components/tasks/task-types.js";


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
let orcRunStoreMod: typeof import("../../components/orc-project/orc-project-run-store.js");

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
}

let doubles: SchedulerDoubles;

function fakeAgentRunner(request: import("../../components/spin-types.js").SpinRequest): Promise<{ cardId: number; result: string }> {
  const entryId = (request.title ?? "").toLowerCase().replace(/\s+/g, "-");
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
  const cardId = board.kanbanEnqueue(request.title ?? entryId, "task", request.goal?.slice(0, 80));
  // Report tasks: the provider writes the declared artifact before settling.
  if (entryId === "report-task") {
    const dir = join(TEST_HOME, "workspace", "report-task");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), `## Summary\n\nFinance report body with enough bytes to pass the 100-byte minimum contract. \nAdditional verified sections for the report pipeline.\n`);
  }
  return Promise.resolve({ cardId, result: `result for ${entryId}` });
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
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME, abmindHome: () => join(TEST_HOME, "..", "abmind-test") }));
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
  orcRunStoreMod = await import("../../components/orc-project/orc-project-run-store.js");
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
  const queue = new CronQueue("kiro-cli", ".", coordinator);
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
  const queue = new CronQueue("kiro-cli", ".", coordinator);
  return { queue, coordinator };
}

/** #1548: per-test scripted Orc boundary wired into the real reconciler. */
async function makeFixture(opts?: Parameters<typeof makeFixtureFactory>[1]) {
  const { fixture, orc } = makeFixtureFactory({
    OrcProjectCoordinator: (await import("../../components/orc-project/orc-project-coordinator.js")).OrcProjectCoordinator,
    ProjectReviewStore: (await import("../../components/project-acceptance/project-review-store.js")).ProjectReviewStore,
    kanban: await import("../../components/tasks/kanban-board.js"),
    nerve: (await import("../../components/nerve.js")).nerve,
    WorkerSupervisionService: (await import("../../components/worker-supervision-service.js")).WorkerSupervisionService,
    WorkerSupervisionStore: (await import("../../components/worker-supervision-store.js")).WorkerSupervisionStore,
  }, opts);
  reconcilerModule.setOrcCoordinator(orc);
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

function events(taskId: string): Array<{ outcome: string; runId?: string; groupId?: string; diagnostic?: { category: string; code: string } }> {
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
    pausedNotifications: [], spawnedCommands: [],
  };
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
  registry.getSystemTaskRegistry().register("sleep-cycle", (entry) => {
    doubles.sleepCycleCalls++;
    if (doubles.sleepCycleCalls === 1) {
      return { status: "deferred", retryAt: Date.now() + 60_000, detail: "sleep active" };
    }
    if (doubles.sleepCycleCalls === 2) {
      return { status: "noop", detail: "already asleep" };
    }
    return { status: "accepted", detail: "cycle handled" };
  });
});

afterEach(() => {
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
  it("delivers exactly one announcement after settlement", async () => {
    const queue = await makeQueue();
    forceDue("announce-task");
    await runTick(queue);
    const ev = events("announce-task");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.outcome).toBe("success");

    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    expect(doubles.sentMessages).toHaveLength(1);
    expect(doubles.sentMessages[0]).toContain("complete");
  });
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

describe("#1520 scheduler E2E — journey 6: transient failure, retry, pause, restart, resume, success", () => {
  it("retries once per group, pauses after three failed groups, resumes atomically, succeeds", async () => {
    const queue = await makeQueue();
    // Each group: attempt 1 transient → retry; attempt 2 transient → count.
    doubles.providerFailures = 6;
    for (let group = 0; group < 3; group++) {
      forceDue("flaky-task");
      await runTick(queue);
      forceDue("flaky-task");
      await runTick(queue);
    }

    const ev = events("flaky-task");
    if (ev.length !== 6) console.error("FLAKY:", JSON.stringify(ev));
    expect(ev).toHaveLength(6);
    expect(ev.filter(e => e.outcome === "failed")).toHaveLength(6);
    const state = stateStore.readState("flaky-task")!;
    expect(state.consecutiveFailures).toBe(3);
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

    // Duplicate delivery polls send exactly once.
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    await delivery.pollPendingDeliveries(makeDeliveryDeps());
    expect(doubles.sentMessages).toHaveLength(1);
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
      const { ProjectReviewStore } = await import("../../components/project-acceptance/project-review-store.js");
      expect(new reviewStoreMod.ProjectReviewStore().getSupervision(rootCardId)?.state).toBe("executing");
      fixture2.fixture.adoptRoot(rootCardId);
      fixture2.fixture.completeWorkers();
      fixture2.fixture.holdAcceptance = false;
      fixture2.fixture.accept();
      await waitFor(() => queue2.currentJobs.length === 0 && !stateStore.readState("project-task")?.activeRun);

      const ev = events("project-task");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.outcome).toBe("success");
      expect(ev[0]!.runId).toBe(firstRunId);
      expect(rootCardId).toBeDefined();
      // Root O + its fixture worker W are done; no duplicates.
      expect(cardStatuses().filter(s => s.endsWith(":done"))).toHaveLength(2);
      scheduler2.stop();
    } finally {
      scheduler.stop();
    }
  });
});

describe("#1548 Task-1 gate — real admission under controlled time", () => {
  it("reserves through the real queue with the production 30-minute deadline and settles once as deadline_exceeded", async () => {
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

      // Acceptance never arrives: the run must be killed by its deadline,
      // never by an unrelated event and never before it.
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
      // Real reservation carries the production-derived absolute deadline.
      expect(run.deadlineAt - run.reservedAt).toBe(30 * 60 * 1000);
      expect(run.cardId).toBeDefined();
      expect(queue.currentJobs.map(j => j.entryId)).toContain("project-task");

      // Advance well past the deadline in one controlled jump: the
      // waitForProjectTerminal 10s recheck, the run-deadline wake source,
      // and the coordinator's deadline path must all fire without deadlock
      // and settle the occurrence exactly once.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 11_000);
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
      await waitForReachControlled(fixture, "repair_planned");
      // The durable repair decision is a named reconciler-owned continuation.
      expect(observer.sample().durableContinuations.some(c => c.kind === "repair_planned")).toBe(true);
      observer.checkpoint();
      reconcilerModule.requestReconcile(rootCardId);
      await waitForReachControlled(fixture, "repairing");
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
