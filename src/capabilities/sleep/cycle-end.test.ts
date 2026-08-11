import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../components/env-schema.js", () => ({
  getEnv: vi.fn(() => ({ sleepQuality: "normal" })),
}));

vi.mock("../../components/system-event-buffer.js", () => ({
  bufferSystemEvent: vi.fn(),
}));

vi.mock("../../components/logger.js", () => ({
  logInfo: vi.fn(),
  logTrace: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../components/transport/bridge-lock-transport.js", () => ({
  writeSleepStatus: vi.fn(),
}));

import { createSleepHandle } from "./index.js";

function makeFakeClient(): any {
  return {
    sleep: {
      start: vi.fn(),
      status: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      events: vi.fn(),
      runtime: { open: vi.fn(), next: vi.fn(), complete: vi.fn(), fail: vi.fn(), close: vi.fn() },
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
}

describe("createSleepHandle — client-backed lifecycle (#1381)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns already_running when sleep is active", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockImplementation(() => new Promise(() => {})); // never resolves

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });

    const r1 = handle.startScheduled();
    expect(r1.status).toBe("accepted");

    const r2 = handle.startScheduled();
    expect(r2.status).toBe("already_running");
  });

  it("calls client.sleep.start with scheduled mode", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });

    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });

    handle.startScheduled();
    await settle();

    expect(client.sleep.start).toHaveBeenCalledWith("scheduled", "normal", undefined);
  });

  it("calls client.sleep.start with manual mode on /sleep now", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-2" });

    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });

    handle.startManual({ fresh: true, resume: false });
    await settle();

    expect(client.sleep.start).toHaveBeenCalledWith("manual", "ultimate", true);
  });

  it("calls client.sleep.resume when resume=true", async () => {
    const client = makeFakeClient();
    client.sleep.resume.mockResolvedValue({ status: "accepted", runId: "run-3" });

    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });

    handle.startManual({ fresh: false, resume: true });
    await settle();

    expect(client.sleep.resume).toHaveBeenCalled();
  });
});

describe("createSleepHandle — cycle outcome resolution (#1603)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A runnable cycle: pump opens + serves nothing (lease expires), the event
   *  poller observes a terminal cycle_finished batch. */
  function runningCycle(opts: { terminalDetail?: string; statusLast?: { status: string; report?: string } }) {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-9" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-9" });
    client.sleep.runtime.next.mockResolvedValue({ status: "lease_expired" });
    client.sleep.events.mockResolvedValueOnce({
      runId: "run-9",
      events: [{ seq: 1, at: Date.now(), event: { type: "cycle_finished", detail: opts.terminalDetail } }],
      nextSeq: 2,
      gap: false,
      terminal: true,
    }).mockResolvedValue({ runId: "run-9", events: [], nextSeq: 2, gap: false, terminal: true });
    client.sleep.status.mockResolvedValue({
      state: "terminal",
      last: { runId: "run-9", status: opts.statusLast?.status ?? "completed", report: opts.statusLast?.report, resumable: false, completedSteps: 6, failedSteps: 0 },
    });
    return client;
  }

  it("resolves completion with the observed cycle_finished status", async () => {
    const client = runningCycle({ terminalDetail: "partial" });
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });

    const started = handle.startScheduled();
    expect(started.status).toBe("accepted");
    const outcome = await (started as { completion: Promise<any> }).completion;

    expect(outcome.status).toBe("partial");
  });

  it("delivers the report via bufferSystemEvent before resolving", async () => {
    const client = runningCycle({ terminalDetail: "partial", statusLast: { status: "partial", report: "Sleep partial — 6 completed, 1 failed" } });
    const bufferSystemEvent = vi.fn();
    const onComplete = vi.fn();
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete,
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent,
    });

    const started = handle.startScheduled();
    const outcome = await (started as { completion: Promise<any> }).completion;

    expect(outcome.report).toBe("Sleep partial — 6 completed, 1 failed");
    expect(bufferSystemEvent).toHaveBeenCalledWith("Sleep partial — 6 completed, 1 failed");
  });

  it("fires onComplete for partial (essentials succeeded) but not for failed", async () => {
    const partialClient = runningCycle({ terminalDetail: "partial" });
    const partialOnComplete = vi.fn();
    const partialHandle = createSleepHandle({
      client: partialClient, memoryEnabled: true, onComplete: partialOnComplete,
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });
    const startedPartial = partialHandle.startScheduled();
    await (startedPartial as { completion: Promise<any> }).completion;
    expect(partialOnComplete).toHaveBeenCalledTimes(1);

    const failedClient = runningCycle({ terminalDetail: "failed", statusLast: { status: "failed" } });
    const failedOnComplete = vi.fn();
    const failedHandle = createSleepHandle({
      client: failedClient, memoryEnabled: true, onComplete: failedOnComplete,
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });
    const startedFailed = failedHandle.startScheduled();
    await (startedFailed as { completion: Promise<any> }).completion;
    expect(failedOnComplete).not.toHaveBeenCalled();
  });

  it("collects failing step ids from step_failed events into the outcome", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-9" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-9" });
    client.sleep.runtime.next.mockResolvedValue({ status: "lease_expired" });
    client.sleep.events.mockResolvedValueOnce({
      runId: "run-9",
      events: [
        { seq: 1, at: Date.now(), event: { type: "step_failed", detail: "retro-derive" } },
        { seq: 2, at: Date.now(), event: { type: "cycle_finished", detail: "partial" } },
      ],
      nextSeq: 3,
      gap: false,
      terminal: true,
    }).mockResolvedValue({ runId: "run-9", events: [], nextSeq: 3, gap: false, terminal: true });
    client.sleep.status.mockResolvedValue({ state: "terminal", last: { status: "partial", resumable: false, completedSteps: 6, failedSteps: 1 } });
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });

    const started = handle.startScheduled();
    const outcome = await (started as { completion: Promise<any> }).completion;

    expect(outcome.failedSteps).toContain("retro-derive");
  });

  it("reports progress once per non-empty poll batch", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-9" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-9" });
    client.sleep.runtime.next.mockResolvedValue({ status: "lease_expired" });
    client.sleep.events.mockResolvedValueOnce({
      runId: "run-9",
      events: [{ seq: 1, at: Date.now(), event: { type: "cycle_started" } }],
      nextSeq: 2,
      gap: false,
      terminal: false,
    }).mockResolvedValueOnce({
      runId: "run-9",
      events: [{ seq: 2, at: Date.now(), event: { type: "cycle_finished", detail: "completed" } }],
      nextSeq: 3,
      gap: false,
      terminal: true,
    }).mockResolvedValue({ runId: "run-9", events: [], nextSeq: 3, gap: false, terminal: true });
    client.sleep.status.mockResolvedValue({ state: "terminal", last: { status: "completed", resumable: false, completedSteps: 6, failedSteps: 0 } });

    const onProgress = vi.fn();
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
    });

    handle.startScheduled({ onProgress });
    await settle();

    expect(onProgress).toHaveBeenCalledTimes(2); // one per non-empty batch
  });
});
