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
  redactSecrets: (value: string) => value,
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
      bufferAgentNotice: vi.fn(),
    });
    handle.startScheduled();
    await settleTicks();

    expect(spin).toHaveBeenCalledTimes(1);
    const spinOpts = spin.mock.calls[0]![0] as { timeoutMs: number; deadlineAt: number; providerInactivityTimeoutMs: number; candidatePolicy: string; executionOrigin?: string };
    // #1611: the provider window is the broker deadline minus 30s cleanup headroom.
    expect(spinOpts.timeoutMs).toBeGreaterThan(85_000);
    expect(spinOpts.timeoutMs).toBeLessThanOrEqual(90_000);
    expect(spinOpts.deadlineAt).toBeGreaterThan(Date.now());
    expect(spinOpts.providerInactivityTimeoutMs).toBe(spinOpts.timeoutMs);
    expect(spinOpts.candidatePolicy, "sleep must never inherit a fallback chain").toBe("configured-only");
    expect(spinOpts.executionOrigin, "sleep must carry its trusted authorization origin").toBe("sleep");
    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "done");
  });

  it("does not grant an already expired provider window a fresh execution — fails once, keeps serving", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(-5000)));
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
      bufferAgentNotice: vi.fn(),
      quarantineSession,
    });
    handle.startScheduled();
    await settleTicks();

    // #1912: no execution started, so the session is healthy — the
    // completion fails once with transient facts and the pump continues to
    // the lease-expired close instead of stopping.
    expect(spin).not.toHaveBeenCalled();
    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_timeout", expect.objectContaining({ cause: expect.any(String), failureClass: "transient", reachedModel: false }));
    expect(quarantineSession, "no execution ran — nothing to fence").not.toHaveBeenCalled();
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(2);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1912: a hanging model generation is fenced and failed once, then the pump keeps serving on a fresh session", async () => {
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
        bufferAgentNotice: vi.fn(),
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
      expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_timeout", expect.objectContaining({ cause: expect.any(String) }));
      expect(client.sleep.runtime.complete, "a timed-out generation must never complete a broker request").not.toHaveBeenCalled();
      expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
      expect(handle.isActive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("#1912: an early provider rejection fails once with facts and keeps serving — healthy session, no fence", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000), makeRequest(120_000)));
    client.sleep.runtime.fail.mockResolvedValue({ status: "ok" });
    client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockRejectedValueOnce(new Error("transport init failed")).mockResolvedValue(settleSpin("recovered"));
    const quarantineSession = vi.fn();

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    // No execution started, so the session is healthy and kept: the failed
    // completion settles once with normalized facts and the next attempt is
    // served on the same session.
    expect(spin).toHaveBeenCalledTimes(2);
    expect(quarantineSession).not.toHaveBeenCalledWith("d-night-1", "provider_failed");
    expect(quarantineSession).not.toHaveBeenCalledWith("d-night-1", "provider_timeout");
    expect(client.sleep.runtime.fail).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_failed", expect.objectContaining({ cause: expect.any(String), failureClass: "unknown" }));
    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "recovered");
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1752: bounds and validates structured failure metadata before the fail RPC", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000)));
    client.sleep.runtime.fail.mockResolvedValue({ status: "ok" });
    const error = Object.assign(new Error("provider trace"), {
      failure: {
        cause: "forged_cause",
        detail: "x".repeat(300),
        commandFingerprint: "not-a-fingerprint",
      },
    });
    const spin = vi.fn().mockRejectedValue(error);

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
    });
    handle.startScheduled();
    await settleTicks();

    const failure = client.sleep.runtime.fail.mock.calls[0]?.[3] as { cause: string; detail?: string; commandFingerprint?: string };
    expect(failure.cause).toBe("unknown");
    expect(failure.detail).toHaveLength(240);
    expect(failure.commandFingerprint).toBeUndefined();
  });

  it("#1912: a spin settling without a semantic result is fenced and failed once, never complete(\"\") — then serving continues", async () => {
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
      bufferAgentNotice: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_failed", expect.objectContaining({ cause: expect.any(String) }));
    expect(client.sleep.runtime.complete).not.toHaveBeenCalled();
    expect(quarantineSession, "an indeterminate execution fences its session").toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.next, "the pump continues to the lease close").toHaveBeenCalledTimes(2);
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
      bufferAgentNotice: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "", "empty");
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
      bufferAgentNotice: vi.fn(),
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "", "no_reply");
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
      bufferAgentNotice: vi.fn(),
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "", "reaction");
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
      bufferAgentNotice: vi.fn(),
    });
    handle.startScheduled();
    await settleTicks();

    expect(spin).not.toHaveBeenCalled();
    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_timeout", expect.objectContaining({ cause: expect.any(String) }));
    // #1912: even a rejected fail RPC cannot keep the pump polling forever —
    // it continues to the lease close rather than stopping mid-cycle.
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(2);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1912: a fail-RPC error keeps the healthy session and continues polling after a provider rejection", async () => {
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
      bufferAgentNotice: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    // #1912: the execution finished, so the session is healthy and kept —
    // only the unreported completion is lost (abmind reconciles via its
    // deadline path). The pump continues to the lease close.
    expect(quarantineSession).not.toHaveBeenCalledWith(expect.anything(), "provider_failed");
    expect(quarantineSession).not.toHaveBeenCalledWith(expect.anything(), "provider_timeout");
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(2);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1611: a hanging fail RPC cannot hold settlement past the reserved cleanup window", async () => {
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
        bufferAgentNotice: vi.fn(),
        quarantineSession,
        allocateSleepSession: () => "d-night-1",
      });
      handle.startScheduled();
      await vi.advanceTimersByTimeAsync(0);

      expect(quarantineSession).not.toHaveBeenCalledWith(expect.anything(), "provider_failed");
    expect(quarantineSession).not.toHaveBeenCalledWith(expect.anything(), "provider_timeout");
      expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_failed", expect.objectContaining({ cause: expect.any(String) }));

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

  it("#1912: a stale completion (invalid_completion) does not poison the pump — the next attempt is served", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000), makeRequest(120_000)));
    client.sleep.runtime.complete
      .mockResolvedValueOnce({ status: "invalid_completion" })
      .mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockResolvedValue(settleSpin("late"));

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
    });
    handle.startScheduled();
    await settleTicks();

    // #1912: the broker already fenced the stale completion — failing the
    // dead id again would be noise. The healthy session keeps serving.
    expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "late");
    expect(client.sleep.runtime.fail, "a fenced completion is never failed again").not.toHaveBeenCalled();
    expect(spin).toHaveBeenCalledTimes(2);
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(3);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1912: a completion RPC error keeps the finished execution's session and continues polling", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000)));
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
      bufferAgentNotice: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    // #1912: the execution finished, so the healthy session is kept and the
    // unreported completion is failed once for supervision to reconcile.
    expect(quarantineSession).not.toHaveBeenCalledWith(expect.anything(), "provider_failed");
    expect(quarantineSession).not.toHaveBeenCalledWith(expect.anything(), "provider_timeout");
    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_failed", expect.objectContaining({ cause: expect.any(String) }));
    expect(spin).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(2);
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1912: a broker-fenced completion keeps the healthy session — no quarantine, no double-fail", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000), makeRequest(120_000)));
    client.sleep.runtime.complete
      .mockResolvedValueOnce({ status: "invalid_completion" })
      .mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockResolvedValue(settleSpin("late"));
    const quarantineSession = vi.fn();

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    expect(quarantineSession).not.toHaveBeenCalledWith(expect.anything(), "provider_failed");
    expect(quarantineSession).not.toHaveBeenCalledWith(expect.anything(), "provider_timeout");
    expect(client.sleep.runtime.fail, "a fenced completion is never failed again").not.toHaveBeenCalled();
    expect(spin).toHaveBeenCalledTimes(2);
    expect(client.sleep.runtime.next).toHaveBeenCalledTimes(3);
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
        bufferAgentNotice: vi.fn(),
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
        bufferAgentNotice: vi.fn(),
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
      bufferAgentNotice: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.isActive).toBe(true);

    // The provider cutoff fires while the transport is still hanging.
    await vi.advanceTimersByTimeAsync(70_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_timeout", expect.objectContaining({ cause: expect.any(String) }));
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
      bufferAgentNotice: vi.fn(),
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
      bufferAgentNotice: vi.fn(),
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
        bufferAgentNotice: vi.fn(),
      });
      handle.startScheduled();
      await vi.advanceTimersByTimeAsync(0);

      // The provider cutoff (broker deadline - 30s headroom) fires while the
      // real Spin awaits the hanging transport.
      await vi.advanceTimersByTimeAsync(70_000);
      await vi.advanceTimersByTimeAsync(0);

      // The ended session is pruned from listAllSessions — look it up by id.
      const session = spin.getSessionById(allocatedId);
      expect(session).toBeDefined();
      if (!session) throw new Error("expected quarantined session");
      expect(runtime.session, "exactly one configured-only transport attempt — no fallback").toHaveBeenCalledTimes(1);
      expect(runtime.session.mock.calls[0]![2]).toEqual({ candidatePolicy: "configured-only" });
      expect(session.status, "the exact Dreamy session is quarantined").toBe("ended");
      expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_timeout", expect.objectContaining({ cause: expect.any(String) }));
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

  it("#1912: a permanent blocker is recorded with its reason and stops without futile waits", async () => {
    const client = makeFakeClient();
    client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
    client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
    client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(120_000)));
    client.sleep.runtime.fail.mockResolvedValue({ status: "ok" });
    const spin = vi.fn().mockRejectedValue(new Error("401 Unauthorized: invalid API key"));
    const quarantineSession = vi.fn();

    const handle = createSleepHandle({
      client,
      memoryEnabled: true,
      onComplete: vi.fn(),
      onCycleEnd: vi.fn(),
      sessionManager: { spin },
      bufferSystemEvent: vi.fn(),
      bufferAgentNotice: vi.fn(),
      quarantineSession,
      allocateSleepSession: () => "d-night-1",
    });
    handle.startScheduled();
    await settleTicks();

    // Credits/auth/policy blockers stop with their actual reason: the
    // completion fails once as permanent and the pump idles to the lease
    // close — no waits, no fence of a healthy session.
    expect(spin).toHaveBeenCalledTimes(1);
    expect(quarantineSession).not.toHaveBeenCalledWith(expect.anything(), "provider_failed");
    expect(client.sleep.runtime.fail).toHaveBeenCalledTimes(1);
    expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_failed", expect.objectContaining({ failureClass: "permanent" }));
    expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
  });

  it("#1912: a timed-out execution fences its session and the next attempt allocates fresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    try {
      const client = makeFakeClient();
      client.sleep.start.mockResolvedValue({ status: "accepted", runId: "run-1" });
      client.sleep.runtime.open.mockResolvedValue({ status: "ok", leaseId: "lease-1" });
      client.sleep.runtime.next.mockImplementation(nextSequence(makeRequest(100_000), makeRequest(200_000)));
      client.sleep.runtime.fail.mockResolvedValue({ status: "ok" });
      client.sleep.runtime.complete.mockResolvedValue({ status: "ok" });
      const spin = vi.fn()
        .mockReturnValueOnce(new Promise(() => {})) // hangs past the cutoff
        .mockResolvedValue(settleSpin("recovered", "s-fresh"));
      const quarantineSession = vi.fn();

      const handle = createSleepHandle({
        client,
        memoryEnabled: true,
        onComplete: vi.fn(),
        onCycleEnd: vi.fn(),
        sessionManager: { spin },
        bufferSystemEvent: vi.fn(),
        bufferAgentNotice: vi.fn(),
        quarantineSession,
        allocateSleepSession: () => "d-night-1",
      });
      handle.startScheduled();
      await vi.advanceTimersByTimeAsync(0);

      // The provider cutoff fires while the transport hangs: fence once,
      // fail once with transient facts, then keep serving.
      await vi.advanceTimersByTimeAsync(70_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(spin).toHaveBeenCalledTimes(2);
      expect(quarantineSession).toHaveBeenCalledWith("d-night-1", "provider_timeout");
      expect(quarantineSession).not.toHaveBeenCalledWith(expect.anything(), "provider_failed");
      expect(client.sleep.runtime.fail).toHaveBeenCalledWith("lease-1", "c1", "provider_timeout", expect.objectContaining({ failureClass: "transient" }));
      const secondSpinOpts = spin.mock.calls[1]![0] as { sessionId?: string };
      expect(secondSpinOpts.sessionId, "a fenced session is replaced, never reused").toBeUndefined();
      expect(client.sleep.runtime.complete).toHaveBeenCalledWith("lease-1", "c1", "recovered");
      expect(client.sleep.runtime.close).toHaveBeenCalledWith("lease-1");
    } finally {
      vi.useRealTimers();
    }
  });
});
