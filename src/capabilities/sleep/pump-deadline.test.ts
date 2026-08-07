import { describe, it, expect, vi, beforeEach } from "vitest";

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

async function settleTicks(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 1));
}

function makeRequest(deadlineInMs: number): { status: "ok"; completionRequest: { completionId: string; runId: string; stepId: string; prompt: string; deadline: number } } {
  return {
    status: "ok",
    completionRequest: {
      completionId: "c1",
      runId: "run-1",
      stepId: "step-1",
      prompt: "prompt",
      deadline: Date.now() + deadlineInMs,
    },
  };
}

/** Each served request must be followed by a terminal status so the pump loop
 *  ends instead of forming an unbounded heartbeat microtask chain. */
function nextSequence(...requests: unknown[]): ReturnType<typeof vi.fn> {
  const m = vi.fn();
  for (const r of requests) m.mockResolvedValueOnce(r);
  m.mockResolvedValue({ status: "lease_expired" });
  return m;
}

describe("createSleepHandle provider pump terminal settlement (#1517)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives the model timeout from the broker's remaining absolute deadline", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000)));
    client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockResolvedValue({ result: "done", sessionId: "s1" });

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
    });
    handle.startScheduled();
    await settleTicks();

    expect(spin).toHaveBeenCalledTimes(1);
    const spinOpts = spin.mock.calls[0]![0] as { timeoutMs: number };
    expect(spinOpts.timeoutMs).toBeGreaterThan(5000);
    expect(spinOpts.timeoutMs).toBeLessThanOrEqual(120_000);
    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "done");
  });

  it("does not grant an already expired request a fresh execution window — the completion is failed, the pump keeps serving", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(-5000), makeRequest(120_000)));
    client.sleep.runtime.fail.mockResolvedValue({ status: "ok" });
    client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockResolvedValue({ result: "next", sessionId: "s1" });

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
    });
    handle.startScheduled();
    await settleTicks();

    expect(spin).toHaveBeenCalledTimes(1);
    expect(spin.mock.calls[0]![0]).toMatchObject({ prompt: "prompt" });
    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "completion_deadline_expired");
    // The expired completion cost only itself — the next request is served.
    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "next");
  });

  it("#1603: a timed-out completion fails that completion only — the pump continues and serves the next request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    try {
      const client = makeFakeClient();
      client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
      client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
      // Each request's deadline is computed at serve time (fresh fake clock).
      client.sleep.runtime.next.mockImplementation(() => {
        const r = makeRequest(100_000);
        if (client.sleep.runtime.next.mock.calls.length === 1) return Promise.resolve(r);
        if (client.sleep.runtime.next.mock.calls.length === 2) return Promise.resolve(r);
        return Promise.resolve({ status: "lease_expired" });
      });
      client.sleep.runtime.fail.mockResolvedValue({ status: "invalid_completion" });
      client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
      const spin = vi.fn()
        .mockReturnValueOnce(new Promise(() => {})) // hangs → deadline
        .mockResolvedValueOnce({ result: "second", sessionId: "s1" });

      const handle = createSleepHandle({
        client,
        memoryEnabled: true,
        onComplete: vi.fn(),
        onCycleEnd: vi.fn(),
        sessionManager: { spin },
        bufferSystemEvent: vi.fn(),
      });
      handle.startScheduled();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(100_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "completion_deadline_expired");
      // invalid_completion from the broker's deadline settle keeps the lease —
      // the pump must serve the next request, not close after the first.
      expect(spin).toHaveBeenCalledTimes(2);
      expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "second");
      expect(client.sleep.runtime.next).toHaveBeenCalledTimes(3); // 2 requests + terminal poll
    } finally {
      vi.useRealTimers();
    }
  });

  it("#1603: the pump exits on invalid_lease after a deadline — the lease is genuinely gone", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(-5000)));
    client.sleep.runtime.fail.mockResolvedValue({ status: "invalid_lease" });
    const spin = vi.fn();

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
    });
    handle.startScheduled();
    await settleTicks();

    expect(spin).not.toHaveBeenCalled();
    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "completion_deadline_expired");
    // invalid_lease means we lost the lease — the pump must terminate.
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1603 recovery finding: a transient next() RPC failure is retried — the pump survives and serves the next request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    try {
      const client = makeFakeClient();
      client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
      client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
      client.sleep.runtime.next
        .mockRejectedValueOnce(new Error("Request timeout")) // transport race
        .mockImplementation(nextSequence(makeRequest(120_000)));
      client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
      const spin = vi.fn().mockResolvedValue({ result: "served", sessionId: "s1" });

      const handle = createSleepHandle({
        client,
        memoryEnabled: true,
        onComplete: vi.fn(),
        onCycleEnd: vi.fn(),
        sessionManager: { spin },
        bufferSystemEvent: vi.fn(),
      });
      handle.startScheduled();
      await vi.advanceTimersByTimeAsync(0);
      // Elapse the 3s RPC-retry backoff, then the pump serves the request.
      await vi.advanceTimersByTimeAsync(4000);
      await vi.advanceTimersByTimeAsync(0);

      // The RPC failure did NOT kill the pump: the completion is still served.
      expect(spin).toHaveBeenCalledTimes(1);
      expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "served");
    } finally {
      vi.useRealTimers();
    }
  });

  it("#1603 recovery finding: sustained next() RPC loss gives up — the pump closes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    try {
      const client = makeFakeClient();
      client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
      client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
      client.sleep.runtime.next.mockRejectedValue(new Error("Request timeout"));
      const spin = vi.fn();

      const handle = createSleepHandle({
        client,
        memoryEnabled: true,
        onComplete: vi.fn(),
        onCycleEnd: vi.fn(),
        sessionManager: { spin },
        bufferSystemEvent: vi.fn(),
      });
      handle.startScheduled();
      await vi.advanceTimersByTimeAsync(0);

      // 10 retries × 3s backoff, then give up.
      await vi.advanceTimersByTimeAsync(40_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(spin).not.toHaveBeenCalled();
      expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
      expect(client.sleep.runtime.next).toHaveBeenCalledTimes(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#1603: a late completed result (invalid_completion) fails that completion only — the pump continues, then exits on lease expiry", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000), makeRequest(120_000)));
    client.sleep.runtime.complete.mockResolvedValue({ status: "invalid_completion" });
    const spin = vi.fn().mockResolvedValue({ result: "late", sessionId: "s1" });

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
    });
    handle.startScheduled();
    await settleTicks();

    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "late");
    // The broker's deadline settle already owned this completion — the lease
    // survives and the pump serves the next request before lease expiry.
    expect(spin).toHaveBeenCalledTimes(2);
    expect(client.sleep.runtime.complete).toHaveBeenCalledTimes(2);
    // One best-effort close once the lease actually expires.
    expect(client.sleep.runtime.close).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(3); // 2 requests + terminal poll
  });

  it("keeps polling after an accepted fail() but exits when fail() is rejected", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000), makeRequest(120_000)));
    client.sleep.runtime.fail
      .mockResolvedValueOnce({ status: "ok" })
      .mockResolvedValue({ status: "invalid_lease" });
    const spin = vi.fn()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValue({ result: "ok", sessionId: "s2" });

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
    });
    handle.startScheduled();
    await settleTicks();

    expect(spin).toHaveBeenCalledTimes(2);
    // Second fail() was rejected → the pump terminates instead of polling again.
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(2);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("contains a transport that ignores cancellation: deadline race ends the pump and frees the handle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(100_000)));
    client.sleep.runtime.fail.mockResolvedValue({ status: "invalid_lease" });
    const spin = vi.fn().mockReturnValue(new Promise(() => {}));

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
    });
    handle.startScheduled();
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.isActive).toBe(true);

    // The deadline fires while the transport is still hanging.
    await vi.advanceTimersByTimeAsync(100_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "completion_deadline_expired");
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
    expect(handle.isActive).toBe(false);

    // A later cycle can open a fresh lease and serve a new request.
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-2" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-2" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(60_000)));
    client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
    spin.mockResolvedValue({ result: "fresh", sessionId: "s2" });

    handle.startScheduled();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-2", "c1", "fresh");

    vi.useRealTimers();
  });

  it("pumps every provider generation into the cycle's allocated session (#1538)", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000), makeRequest(120_000)));
    client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockResolvedValue({ result: "done", sessionId: "s1" });
    const allocateSleepSession = vi.fn().mockReturnValue("d-night-1");

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      allocateSleepSession,
    });
    handle.startScheduled();
    await settleTicks();

    // Regression: before #1538 the allocated id was discarded, so the first
    // generation carried undefined and spin() allocated an unnamed sibling.
    expect(spin).toHaveBeenCalledTimes(2);
    for (const call of spin.mock.calls) {
      expect((call[0] as { sessionId?: string }).sessionId).toBe("d-night-1");
    }

    // Second cycle, same handle: the identity must not outlive the cycle — a
    // retained id would pump into a session the idle reaper had already ended.
    allocateSleepSession.mockReturnValue("d-night-2");
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-2" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000), makeRequest(120_000)));
    handle.startScheduled();
    await settleTicks();

    const secondCycleCalls = spin.mock.calls.slice(2);
    expect(secondCycleCalls).toHaveLength(2);
    for (const call of secondCycleCalls) {
      expect((call[0] as { sessionId?: string }).sessionId).toBe("d-night-2");
    }
  });

  it("does not retain a provider-allocated session id across cycles (#1538)", async () => {
    // No allocator: the identity comes from the provider's spin result. The
    // first generation of each cycle carries no id and captures the returned
    // one for the rest of the cycle — a retained id from the ended cycle
    // would leak into the next cycle's first generation instead.
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000), makeRequest(120_000)));
    client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
    const spin = vi.fn()
      .mockResolvedValueOnce({ result: "done", sessionId: "d-night-1" })
      .mockResolvedValueOnce({ result: "done", sessionId: "d-night-1" })
      .mockResolvedValueOnce({ result: "done", sessionId: "d-night-2" })
      .mockResolvedValueOnce({ result: "done", sessionId: "d-night-2" });

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
    });
    handle.startScheduled();
    await settleTicks();

    expect((spin.mock.calls[0]![0] as { sessionId?: string }).sessionId).toBeUndefined();
    expect((spin.mock.calls[1]![0] as { sessionId?: string }).sessionId).toBe("d-night-1");

    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-2" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000), makeRequest(120_000)));
    handle.startScheduled();
    await settleTicks();

    expect((spin.mock.calls[2]![0] as { sessionId?: string }).sessionId).toBeUndefined();
    expect((spin.mock.calls[3]![0] as { sessionId?: string }).sessionId).toBe("d-night-2");
  });
});
