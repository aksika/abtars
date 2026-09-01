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
  redactSecrets: (value: string) => value,
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
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-0" });
    client.sleep.start.mockImplementation(() => new Promise(() => {})); // never resolves

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
    });

    const r1 = handle.startScheduled();
    expect(r1.status).toBe("accepted");

    const r2 = handle.startScheduled();
    expect(r2.status).toBe("already_running");
  });

  it("calls client.sleep.start with scheduled mode", async () => {
    const client = makeFakeClient();
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });

    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
    });

    handle.startScheduled();
    await settle();

    expect(client.sleep.start).toHaveBeenCalledWith("scheduled", "normal", undefined);
  });

  it("calls client.sleep.start with manual mode on /sleep now", async () => {
    const client = makeFakeClient();
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-2" });
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-2" });

    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
    });

    handle.startManual({ fresh: true, resume: false });
    await settle();

    expect(client.sleep.start).toHaveBeenCalledWith("manual", "ultimate", true);
  });

  it("calls client.sleep.resume when resume=true", async () => {
    const client = makeFakeClient();
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-3" });
    client.sleep.resume.mockResolvedValue({ status: "accepted", runId: "run-3" });

    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
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
      bufferAgentNotice: vi.fn(),
    });

    const started = handle.startScheduled();
    expect(started.status).toBe("accepted");
    const outcome = await (started as { completion: Promise<any> }).completion;

    expect(outcome.status).toBe("partial");
  });

  it("delivers a partial report via bufferAgentNotice (dreamy), never via bufferSystemEvent (#1653)", async () => {
    const client = runningCycle({ terminalDetail: "partial", statusLast: { status: "partial", report: "Sleep partial — 6 completed, 1 failed" } });
    const bufferSystemEvent = vi.fn();
    const bufferAgentNotice = vi.fn();
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent,
      bufferAgentNotice,
    });

    const started = handle.startScheduled();
    const outcome = await (started as { completion: Promise<any> }).completion;

    expect(outcome.report).toBe("Sleep partial — 6 completed, 1 failed");
    expect(bufferAgentNotice, "the degraded report goes to the agent notice exactly once").toHaveBeenCalledTimes(1);
    expect(bufferAgentNotice).toHaveBeenCalledWith("dreamy", "Sleep partial — 6 completed, 1 failed");
    expect(bufferSystemEvent, "the plain system path must NOT see a degraded report").not.toHaveBeenCalled();
  });

  it("delivers a completed report via bufferSystemEvent, never via bufferAgentNotice (#1653)", async () => {
    const client = runningCycle({ terminalDetail: "completed", statusLast: { status: "completed", report: "Sleep completed — 6 completed, 0 failed, 0 skipped (of 6)." } });
    const bufferSystemEvent = vi.fn();
    const bufferAgentNotice = vi.fn();
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent,
      bufferAgentNotice,
    });

    const started = handle.startScheduled();
    await (started as { completion: Promise<any> }).completion;

    expect(bufferSystemEvent, "the ordinary report goes to the system path exactly once").toHaveBeenCalledTimes(1);
    expect(bufferSystemEvent).toHaveBeenCalledWith("Sleep completed — 6 completed, 0 failed, 0 skipped (of 6).");
    expect(bufferAgentNotice, "a healthy report never reaches the agent notice").not.toHaveBeenCalled();
  });

  it("delivers a failed report via bufferAgentNotice exactly once (#1653)", async () => {
    const client = runningCycle({ terminalDetail: "failed", statusLast: { status: "failed", report: "Sleep failed — 2 completed, 1 failed, 3 skipped (of 6). Essential failures: extract-memories. Review degraded — extract-memories: no extraction writes." } });
    const bufferSystemEvent = vi.fn();
    const bufferAgentNotice = vi.fn();
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent,
      bufferAgentNotice,
    });

    const started = handle.startScheduled();
    await (started as { completion: Promise<any> }).completion;

    expect(bufferAgentNotice).toHaveBeenCalledTimes(1);
    expect(bufferAgentNotice).toHaveBeenCalledWith("dreamy", expect.stringContaining("Review degraded"));
    expect(bufferSystemEvent).not.toHaveBeenCalled();
  });

  it("a throwing delivery callback cannot change the settled sleep outcome (#1653)", async () => {
    const client = runningCycle({ terminalDetail: "failed", statusLast: { status: "failed", report: "Sleep failed — 0 completed, 1 failed" } });
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: () => { throw new Error("buffer down"); },
    });

    const started = handle.startScheduled();
    const outcome = await (started as { completion: Promise<any> }).completion;

    expect(outcome.status).toBe("failed");
    expect(outcome.report).toBe("Sleep failed — 0 completed, 1 failed");
  });

  it("fires onComplete for partial (essentials succeeded) but not for failed", async () => {
    const partialClient = runningCycle({ terminalDetail: "partial" });
    const partialOnComplete = vi.fn();
    const partialHandle = createSleepHandle({
      client: partialClient, memoryEnabled: true, onComplete: partialOnComplete,
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
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
      bufferAgentNotice: vi.fn(),
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
      bufferAgentNotice: vi.fn(),
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
      bufferAgentNotice: vi.fn(),
    });

    handle.startScheduled({ onProgress });
    await settle();

    expect(onProgress).toHaveBeenCalledTimes(2); // one per non-empty batch
  });
});

describe("createSleepHandle — provider lease bootstrap (#1681)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A cycle that accepts the run and terminates immediately: the pump opens
   *  (already owned) + serves nothing, the poller sees a terminal batch. */
  function acceptedCycle(client: any, leaseId: string, runId: string): void {
    client.sleep.runtime.next.mockResolvedValue({ status: "lease_expired" });
    client.sleep.events.mockResolvedValue({
      runId,
      events: [{ seq: 1, at: Date.now(), event: { type: "cycle_finished", detail: "completed" } }],
      nextSeq: 2,
      gap: false,
      terminal: true,
    });
    client.sleep.status.mockResolvedValue({ state: "terminal", last: { runId, status: "completed", resumable: false, completedSteps: 1, failedSteps: 0 } });
  }

  it("opens the runtime lease before client.sleep.start for scheduled mode", async () => {
    const client = makeFakeClient();
    const order: string[] = [];
    client.sleep.runtime.open.mockImplementation(async () => { order.push("open"); return { status: "ok", leaseId: "lease-1" }; });
    client.sleep.start.mockImplementation(async () => { order.push("start"); return { status: "accepted", runId: "run-1" }; });
    acceptedCycle(client, "lease-1", "run-1");

    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
    });
    handle.startScheduled();
    await settle();

    // #1681: the daemon must observe the lease registered before the first
    // model-backed step can dispatch.
    expect(order).toEqual(["open", "start"]);
    expect(client.sleep.start).toHaveBeenCalledWith("scheduled", "normal", undefined);
    // Exactly one owner closes the handed-off lease — the pump's finally path.
    expect(client.sleep.runtime.close).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("opens the runtime lease before client.sleep.resume for resume mode", async () => {
    const client = makeFakeClient();
    const order: string[] = [];
    client.sleep.runtime.open.mockImplementation(async () => { order.push("open"); return { status: "ok", leaseId: "lease-1" }; });
    client.sleep.resume.mockImplementation(async () => { order.push("resume"); return { status: "accepted", runId: "run-1" }; });
    acceptedCycle(client, "lease-1", "run-1");

    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
    });
    handle.startManual({ fresh: false, resume: true });
    await settle();

    expect(order).toEqual(["open", "resume"]);
    expect(client.sleep.resume).toHaveBeenCalledWith(undefined, "normal");
  });

  it("a runtime open failure never starts a daemon run and cleans up once", async () => {
    const client = makeFakeClient();
    client.sleep.runtime.open.mockResolvedValue({ status: "unavailable" });
    const onCycleEnd = vi.fn();
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
      onCycleEnd,
    });
    const started = handle.startScheduled();
    const outcome = await (started as { completion: Promise<any> }).completion;

    expect(outcome.status).toBe("unknown");
    expect(client.sleep.start).not.toHaveBeenCalled();
    expect(client.sleep.resume).not.toHaveBeenCalled();
    expect(client.sleep.runtime.close, "no lease was acquired — nothing to close").not.toHaveBeenCalled();
    expect(handle.isActive).toBe(false);
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("a pre-start cancellation closes the acquired lease and settles cancelled without starting", async () => {
    const client = makeFakeClient();
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.close.mockResolvedValue({ status: "ok" });
    const onCycleEnd = vi.fn();
    const controller = new AbortController();
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
      onCycleEnd,
    });
    const started = handle.startScheduled({ signal: controller.signal });
    controller.abort();
    const outcome = await (started as { completion: Promise<any> }).completion;

    expect(outcome.status).toBe("cancelled");
    expect(client.sleep.start, "a cancelled pre-start must not issue the daemon start").not.toHaveBeenCalled();
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
    expect(client.sleep.runtime.next).not.toHaveBeenCalled();
    expect(handle.isActive).toBe(false);
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("a non-accepted start closes the acquired lease and never runs a cycle", async () => {
    const client = makeFakeClient();
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.close.mockResolvedValue({ status: "ok" });
    client.sleep.start.mockResolvedValue({ status: "already_running" });
    const onCycleEnd = vi.fn();
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
      onCycleEnd,
    });
    const started = handle.startScheduled();
    const outcome = await (started as { completion: Promise<any> }).completion;

    expect(outcome.status).toBe("unknown");
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
    expect(client.sleep.runtime.next, "the pump never starts without an accepted run").not.toHaveBeenCalled();
    expect(handle.isActive).toBe(false);
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("an accepted result without a runId is a pre-handoff failure — lease closed, no cycle", async () => {
    const client = makeFakeClient();
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.close.mockResolvedValue({ status: "ok" });
    client.sleep.start.mockResolvedValue({ status: "accepted" }); // malformed: no runId
    const onCycleEnd = vi.fn();
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
      onCycleEnd,
    });
    const started = handle.startScheduled();
    const outcome = await (started as { completion: Promise<any> }).completion;

    expect(outcome.status).toBe("unknown");
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
    expect(client.sleep.runtime.next).not.toHaveBeenCalled();
    expect(handle.isActive).toBe(false);
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("a rejected start RPC closes the acquired lease and settles unknown once", async () => {
    const client = makeFakeClient();
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.close.mockResolvedValue({ status: "ok" });
    client.sleep.start.mockRejectedValue(new Error("daemon not connected"));
    const onCycleEnd = vi.fn();
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
      onCycleEnd,
    });
    const started = handle.startScheduled();
    const outcome = await (started as { completion: Promise<any> }).completion;

    expect(outcome.status).toBe("unknown");
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
    expect(client.sleep.runtime.next).not.toHaveBeenCalled();
    expect(handle.isActive).toBe(false);
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("a lease-close failure on cleanup does not hide the original start failure", async () => {
    const client = makeFakeClient();
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.close.mockRejectedValue(new Error("daemon gone"));
    client.sleep.start.mockRejectedValue(new Error("start refused"));
    const handle = createSleepHandle({
      client, memoryEnabled: true, onComplete: vi.fn(),
      sessionManager: { spin: vi.fn() },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
    });
    const started = handle.startScheduled();
    const outcome = await (started as { completion: Promise<any> }).completion;

    expect(outcome.status).toBe("unknown");
    expect(handle.isActive).toBe(false);
  });
});
