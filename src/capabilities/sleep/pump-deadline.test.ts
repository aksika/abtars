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
import { classifyContent } from "../../components/clean-response.js";

/** #1651 v2: the spin stub mirrors the production contract — the provider's
 *  own string verbatim plus Spin's single classification of it. A stub that
 *  omits the outcome would make the pump treat a text turn as contentless. */
function settleSpin(result: string, sessionId = "s1"): { result: string; sessionId: string; outcome: ReturnType<typeof classifyContent> } {
  return { result, sessionId, outcome: classifyContent(result) };
}

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

  it("derives the model timeout from the broker deadline minus cleanup headroom, and forces configured-only", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000)));
    client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockResolvedValue(settleSpin("done"));

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
    const spinOpts = spin.mock.calls[0]![0] as { timeoutMs: number; deadlineAt: number; providerInactivityTimeoutMs: number; candidatePolicy: string };
    // #1611: the provider window is the broker deadline minus 30s cleanup headroom.
    expect(spinOpts.timeoutMs).toBeGreaterThan(85_000);
    expect(spinOpts.timeoutMs).toBeLessThanOrEqual(90_000);
    expect(spinOpts.deadlineAt).toBeGreaterThan(Date.now());
    expect(spinOpts.providerInactivityTimeoutMs).toBe(spinOpts.timeoutMs);
    expect(spinOpts.candidatePolicy, "sleep must never inherit a fallback chain").toBe("configured-only");
    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "done");
  });

  it("does not grant an already expired provider window a fresh execution — terminal, no later completion", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(-5000), makeRequest(120_000)));
    client.sleep.runtime.fail.mockResolvedValue({ status: "ok" });
    const spin = vi.fn();
    const quarantineSession = vi.fn();

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      quarantineSession,
    });
    handle.startScheduled();
    await settleTicks();

    // #1611: no spin starts, the completion is failed once with the stable
    // provider_timeout code, and the pump terminates — the next request is
    // never served.
    expect(spin).not.toHaveBeenCalled();
    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_timeout");
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1611: a hanging model generation is terminal — quarantine, provider_timeout, no next step, pump closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    try {
      const client = makeFakeClient();
      client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
      client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
      client.sleep.runtime.next.mockImplementation(() => {
        const r = makeRequest(100_000);
        if (client.sleep.runtime.next.mock.calls.length === 1) return Promise.resolve(r);
        return Promise.resolve({ status: "lease_expired" });
      });
      client.sleep.runtime.fail.mockResolvedValue({ status: "ok" });
      client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
      const spin = vi.fn().mockReturnValue(new Promise(() => {})); // hangs
      const quarantineSession = vi.fn();

      const handle = createSleepHandle({
        client,
        memoryEnabled: true,
        onComplete: vi.fn(),
        onCycleEnd: vi.fn(),
        sessionManager: { spin },
        bufferSystemEvent: vi.fn(),
        quarantineSession,
        allocateSleepSession: () => "d-night-1",
      });
      handle.startScheduled();
      await vi.advanceTimersByTimeAsync(0);

      // The provider cutoff (deadline - 30s headroom) fires while the
      // transport still hangs: quarantine once, fail once, stop the pump.
      await vi.advanceTimersByTimeAsync(70_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(spin).toHaveBeenCalledTimes(1);
      expect(quarantineSession).toHaveBeenCalledTimes(1);
      expect(quarantineSession).toHaveBeenCalledWith("d-night-1", "provider_timeout");
      expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_timeout");
      expect(client.sleep.runtime.complete, "a timed-out generation must never complete a broker request").not.toHaveBeenCalled();
      expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
      expect(handle.isActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#1611: an early provider rejection is terminal — quarantine, provider_failed, no complete(\"\")", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000)));
    client.sleep.runtime.fail.mockResolvedValue({ status: "ok" });
    client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockRejectedValue(new Error("transport init failed"));
    const quarantineSession = vi.fn();

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(spin).toHaveBeenCalledTimes(1);
    expect(quarantineSession).toHaveBeenCalledTimes(1);
    expect(quarantineSession).toHaveBeenCalledWith("d-night-1", "provider_failed");
    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_failed");
    expect(client.sleep.runtime.complete, "a rejected generation must never settle as complete('')").not.toHaveBeenCalled();
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1611: a spin settling without a semantic result is a provider failure, never complete(\"\")", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000)));
    client.sleep.runtime.fail.mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockResolvedValue({ sessionId: "s1" }); // no result
    const quarantineSession = vi.fn();

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_failed");
    expect(client.sleep.runtime.complete).not.toHaveBeenCalled();
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  /*
   * #1651: spin used to fabricate "(no output)" for an empty provider response,
   * so the guard above could never distinguish "no content" from "no result" and
   * every empty sleep step settled as a valid completion (#1650: watermark
   * advanced, nothing extracted). A turn that SETTLED without content is a
   * domain fact, not a transport failure: it goes to the broker as an empty
   * completion and abmind's sendToRuntime owns the bounded empty retry
   * (MAX_DOMAIN_RETRIES -> terminal invalid_response).
   */
  it("#1651: a settled turn carrying no content becomes an empty completion, not a pump failure", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000)));
    client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockResolvedValue(settleSpin(""));
    const quarantineSession = vi.fn();

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "");
    expect(client.sleep.runtime.fail).not.toHaveBeenCalled();
    // cycle_end quarantine is normal teardown; a provider-failure quarantine is not.
    expect(quarantineSession).not.toHaveBeenCalledWith("d-night-1", "provider_failed");
  });

  it("#1651: a [NO_REPLY]-only turn is also settled as empty, never as model content", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000)));
    client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockResolvedValue(settleSpin("[NO_REPLY]"));

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "");
  });

  it("#1651 v2: a reaction-only turn is a chat control signal, not curation content — settled as an empty completion", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000)));
    client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockResolvedValue(settleSpin("[REACT:🧠]"));

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "");
    expect(client.sleep.runtime.fail).not.toHaveBeenCalled();
  });

  it("#1611: the pump exits on invalid_lease after a deadline — the lease is genuinely gone", async () => {
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
    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_timeout");
    // Even a rejected fail RPC cannot keep the pump alive — it terminates.
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1611: a fail-RPC error still terminates the pump locally after a provider rejection", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000)));
    client.sleep.runtime.fail.mockRejectedValue(new Error("daemon gone"));
    const spin = vi.fn().mockRejectedValue(new Error("provider down"));
    const quarantineSession = vi.fn();

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(quarantineSession, "quarantine happens locally before settlement").toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1611: a hanging fail RPC cannot keep the local pump alive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    try {
      const client = makeFakeClient();
      client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
      client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
      client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000)));
      client.sleep.runtime.fail.mockReturnValue(new Promise(() => {}));
      const spin = vi.fn().mockRejectedValue(new Error("provider down"));
      const quarantineSession = vi.fn();

      const handle = createSleepHandle({
        client,
        memoryEnabled: true,
        onComplete: vi.fn(),
        onCycleEnd: vi.fn(),
        sessionManager: { spin },
        bufferSystemEvent: vi.fn(),
        quarantineSession,
        allocateSleepSession: () => "d-night-1",
      });
      handle.startScheduled();
      await vi.advanceTimersByTimeAsync(0);

      expect(quarantineSession).toHaveBeenCalledWith("d-night-1", "provider_failed");
      expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_failed");

      // Failure settlement is capped at the reserved 30s cleanup window,
      // rather than waiting for the whole logical 120s completion deadline.
      await vi.advanceTimersByTimeAsync(30_001);
      await vi.advanceTimersByTimeAsync(0);

      expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
      expect(handle.isActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#1611: a late completed result (invalid_completion) stops the pump — no later completion is polled", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000), makeRequest(120_000)));
    client.sleep.runtime.complete.mockResolvedValue({ status: "invalid_completion" });
    const spin = vi.fn().mockResolvedValue(settleSpin("late"));

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
    // #1611: nothing authorizes polling for another completion after a
    // non-ok settlement.
    expect(spin).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1611: a completion RPC error quarantines the exact session and fails the lease", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000), makeRequest(120_000)));
    client.sleep.runtime.complete.mockRejectedValue(new Error("daemon connection lost"));
    client.sleep.runtime.fail.mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockResolvedValue(settleSpin("served"));
    const quarantineSession = vi.fn();

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(quarantineSession).toHaveBeenCalledWith("d-night-1", "provider_failed");
    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_failed");
    expect(spin).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1611: an invalid completion quarantines the exact session before stopping", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000), makeRequest(120_000)));
    client.sleep.runtime.complete.mockResolvedValue({ status: "invalid_completion" });
    const spin = vi.fn().mockResolvedValue(settleSpin("late"));
    const quarantineSession = vi.fn();

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(quarantineSession).toHaveBeenCalledWith("d-night-1", "provider_failed");
    expect(client.sleep.runtime.fail).not.toHaveBeenCalled();
    expect(spin).toHaveBeenCalledTimes(1);
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
      const spin = vi.fn().mockResolvedValue(settleSpin("served"));

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

  it("#1611: a late completed result after quarantine is inert — the fence settles nothing (transport ignores cancellation)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(100_000)));
    client.sleep.runtime.fail.mockResolvedValue({ status: "invalid_lease" });
    // The spin promise resolves AFTER the provider deadline (a transport that
    // ignores cancellation): the race must win, quarantine must run, and the
    // late result must never reach the broker.
    let resolveLate!: (v: { result: string; sessionId: string; outcome: ReturnType<typeof classifyContent> }) => void;
    const spin = vi.fn().mockReturnValue(new Promise<{ result: string; sessionId: string; outcome: ReturnType<typeof classifyContent> }>(r => { resolveLate = r; }));
    const quarantineSession = vi.fn();

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.isActive).toBe(true);

    // The provider cutoff fires while the transport is still hanging.
    await vi.advanceTimersByTimeAsync(70_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_timeout");
    expect(quarantineSession).toHaveBeenCalledWith("d-night-1", "provider_timeout");
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
    expect(handle.isActive).toBe(false);

    // The transport finally settles late — the broker is never told.
    resolveLate(settleSpin("late result", "d-night-1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.sleep.runtime.complete, "a late provider result must not complete a broker request").not.toHaveBeenCalled();
    expect(client.sleep.runtime.fail).toHaveBeenCalledTimes(1);
    expect(quarantineSession, "quarantine is idempotent — exactly one call").toHaveBeenCalledTimes(1);

    // A later cycle can open a fresh lease and serve a new request.
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-2" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-2" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(60_000)));
    client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
    spin.mockResolvedValue(settleSpin("fresh", "s2"));

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
    const spin = vi.fn().mockResolvedValue(settleSpin("done"));
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
      .mockResolvedValueOnce(settleSpin("done", "d-night-1"))
      .mockResolvedValueOnce(settleSpin("done", "d-night-1"))
      .mockResolvedValueOnce(settleSpin("done", "d-night-2"))
      .mockResolvedValueOnce(settleSpin("done", "d-night-2"));

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

  it("#1611 journey: a hanging configured candidate is quarantined exactly once through the REAL Spin — no fallback, no later step, late result inert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    try {
      const { Spin } = await import("../../components/spin.js");
      const { setUserRegistryOverride } = await import("../../components/user-registry.js");
      const spin = new Spin();
      const master = { userId: "aksika", role: "master" as const, maxClass: 3, tools: ["all"], platforms: { telegram: 111 } };
      setUserRegistryOverride({
        users: [master],
        byPlatformId: new Map([["telegram:111", master]]),
        byUserId: new Map([["aksika", master]]),
      });
      let allocatedId = "";

      // The configured Dreamy transport hangs and ignores cancellation.
      let resolveLate!: (v: string) => void;
      const transport = {
        initialize: vi.fn().mockResolvedValue(undefined),
        sendPrompt: vi.fn().mockReturnValue(new Promise<string>(r => { resolveLate = r; })),
        resetSession: vi.fn().mockResolvedValue(undefined),
        sendInterrupt: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
        get isReady() { return true; },
        get contextPercent() { return -1; },
        get answerOnly() { return ""; },
        get toolCallsSucceeded() { return 0; },
        get intermediateDeliveredText() { return ""; },
      } as any;
      const runtime = {
        session: vi.fn().mockResolvedValue({
          sendPrompt: transport.sendPrompt,
          destroy: vi.fn(),
          get isReady() { return true; },
          get transport() { return transport; },
        }),
      };
      spin.setRuntime(runtime as any);
      const memory = { recordMessage: vi.fn() };
      spin.setMemory(memory as any);

      const client = makeFakeClient();
      client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
      client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
      client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(100_000)));
      client.sleep.runtime.fail.mockResolvedValue({ status: "ok" });
      client.sleep.events.mockResolvedValue({ runId: "run-1", events: [], nextSeq: 1, gap: false, terminal: true });
      client.sleep.status.mockResolvedValue({ state: "terminal", last: { runId: "run-1", status: "failed", resumable: true, completedSteps: 0, failedSteps: 1 } });

      const handle = createSleepHandle({
        client,
        memoryEnabled: true,
        onComplete: vi.fn(),
        onCycleEnd: vi.fn(),
        sessionManager: {
          spin: async (opts: any) => spin.spin({ type: opts.type, prompt: opts.prompt, sessionId: opts.sessionId, timeoutMs: opts.timeoutMs, deadlineAt: opts.deadlineAt, candidatePolicy: opts.candidatePolicy, settlementOwner: "spin", await: true }),
        },
        quarantineSession: (sid, reason) => { spin.finalizeExactSession(sid, "aksika", reason); },
        allocateSleepSession: (name) => { allocatedId = spin.allocateDreamySession(name).id; return allocatedId; },
        bufferSystemEvent: vi.fn(),
      });
      handle.startScheduled();
      await vi.advanceTimersByTimeAsync(0);

      // The provider cutoff (broker deadline - 30s headroom) fires while the
      // real Spin awaits the hanging transport.
      await vi.advanceTimersByTimeAsync(70_000);
      await vi.advanceTimersByTimeAsync(0);

      // The ended session is pruned from listAllSessions — look it up by id.
      const session = spin.getSessionById(allocatedId);
      expect(runtime.session, "exactly one configured-only transport attempt — no fallback").toHaveBeenCalledTimes(1);
      expect(runtime.session.mock.calls[0]![2]).toEqual({ candidatePolicy: "configured-only" });
      expect(session.status, "the exact Dreamy session is quarantined").toBe("ended");
      expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_timeout");
      expect(client.sleep.runtime.complete).not.toHaveBeenCalled();
      expect(handle.isActive).toBe(false);

      // The transport settles late — the real Spin fence must keep it inert.
      resolveLate("late provider result");
      await vi.advanceTimersByTimeAsync(0);
      expect(memory.recordMessage, "a late result must not write memory through the fence").not.toHaveBeenCalled();
      setUserRegistryOverride(null);
    } finally {
      vi.useRealTimers();
    }
  });
});
