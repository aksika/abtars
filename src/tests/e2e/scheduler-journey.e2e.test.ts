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
  projectRuns: number;
  sleepCycleCalls: number;
  sentMessages: string[];
  sentDocuments: Array<{ chatId: string; path: string }>;
  injectedReminders: string[];
  pausedNotifications: string[];
  spawnedCommands: string[];
  /** #1539: when set, fakeProjectRunner holds acceptance until released. */
  projectHold: boolean;
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

async function fakeProjectRunner(request: import("../../components/tasks/scheduled-project-runner.js").ScheduledProjectRequest): Promise<{ cardId: number; result: string; factAt?: number }> {
  doubles.projectRuns++;
  // Use the real scheduled O runner. The deterministic double is only the
  // coordinator/model boundary that accepts the real project after admission.
  const { scheduledProjectRunner } = await import("../../components/tasks/scheduled-project-runner.js");
  const reconcilerModule = await import("../../components/reconciler.js");
  const { ProjectReviewStore } = await import("../../components/project-acceptance/project-review-store.js");
  const { nerve } = await import("../../components/nerve.js");
  reconcilerModule.setOrcCoordinator({
    scheduleScheduledProject(projectCardId: number) {
      setImmediate(() => {
        const store = new ProjectReviewStore();
        // Idempotent claim: a reattached admission may repeat generation/round.
        let reviewCase = store.getLatestReviewCase(projectCardId);
        if (!reviewCase) {
          reviewCase = store.insertReviewCase(projectCardId, 1, 1, { summary: "verified" }, "digest");
        }
        if (doubles.projectHold) return;
        try {
          store.settleAcceptance(projectCardId, reviewCase.id, { accepted: true }, "project accepted");
        } catch {
          // Idempotent double: a late claim must not reverse an already-settled project.
          return;
        }
        nerve.fire("card:done", projectCardId);
      });
      return { kind: "claimed", context: { runId: request.runId, projectCardId } } as never;
    },
  } as never);
  return scheduledProjectRunner(request);
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
    projectRunner: fakeProjectRunner,
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
    projectRunner: fakeProjectRunner,
  });
  const queue = new CronQueue("kiro-cli", ".", coordinator);
  return { queue, coordinator };
}

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
    providerFailures: 0, providerErrors: [], admissionRejections: 0, projectRuns: 0,
    sleepCycleCalls: 0, sentMessages: [], sentDocuments: [], injectedReminders: [],
    pausedNotifications: [], spawnedCommands: [], projectHold: false,
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
  it("supervises via the project runner, validates, settles, releases delivery once", async () => {
    const queue = await makeQueue();
    forceDue("project-task");
    await runTick(queue);
    expect(doubles.projectRuns).toBe(1);

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
      // A long supervised project: acceptance is held until we release it.
      doubles.projectHold = true;
      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      await waitForProjectStarted();
      expect(doubles.projectRuns).toBe(1);
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

      // Release the project: it settles once and releases only its lane.
      doubles.projectHold = false;
      const { ProjectReviewStore } = await import("../../components/project-acceptance/project-review-store.js");
      const { nerve } = await import("../../components/nerve.js");
      const roots = board.kanbanList("*").filter(c => c.type === "O");
      const reviewStore = new ProjectReviewStore();
      const latestCase = reviewStore.getLatestReviewCase(roots[0]!.id);
      reviewStore.settleAcceptance(roots[0]!.id, latestCase!.id, { accepted: true }, "project accepted");
      nerve.fire("card:done", roots[0]!.id);
      await waitFor(() => queue.currentJobs.length === 0 && !stateStore.readState("project-task")?.activeRun);

      const ev = events("project-task");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.outcome).toBe("success");
      // The manual run completed independently with its own row.
      expect(events("announce-task")).toHaveLength(1);
      expect(cardStatuses().filter(s => s.endsWith(":done"))).toHaveLength(2);
      scheduler.stop();
    } finally {
      scheduler.stop();
      doubles.projectHold = false;
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
      doubles.projectHold = true;
      forceDue("project-task");
      await tick.runTaskTick(makeTickCtx(queue));
      await waitForProjectStarted();
      const firstRunId = stateStore.readState("project-task")!.activeRun!.runId;
      const rootId = stateStore.readState("project-task")!.activeRun!.cardId;
      expect(rootId).toBeDefined();

      // Restart: a fresh queue/coordinator recovers the active occurrence and
      // reattaches the SAME run through admission.
      const { queue: queue2, coordinator: coordinator2 } = await makeQueueWithCoordinator();
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

      // Release acceptance: the reattached run's pending claim (queued at
      // admission) settles the project and the occurrence settles exactly once.
      doubles.projectHold = false;
      await waitFor(() => queue2.currentJobs.length === 0 && !stateStore.readState("project-task")?.activeRun);

      const ev = events("project-task");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.outcome).toBe("success");
      expect(ev[0]!.runId).toBe(firstRunId);
      expect(cardStatuses().filter(s => s.endsWith(":done"))).toHaveLength(1);
      scheduler2.stop();
    } finally {
      scheduler.stop();
      doubles.projectHold = false;
    }
  });
});

async function waitForProjectStarted(): Promise<void> {
  await waitFor(() => doubles.projectRuns === 1 && stateStore.readState("project-task")?.activeRun?.cardId !== undefined);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("condition not reached within timeout");
}
