/**
 * spin — #1611 exact Dreamy quarantine and late-result fencing.
 *
 * A hanging persistent generation that is quarantined (session ended) must
 * settle as INERT: no memory write, no step callback, no execution clear, no
 * termination of a later state. Quarantine itself is idempotent, and the
 * candidate policy is immutable per attached session (conflicting reuse fails
 * closed). Healthy multi-step cycles keep ONE transport until terminal
 * cleanup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Spin } from "./spin.js";
import { setUserRegistryOverride } from "./user-registry.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";

function makeUser(userId: string, role: "master" | "user" | "guest", telegram = 100) {
  return { userId, role, maxClass: role === "master" ? 3 : 1, tools: ["all"], platforms: { telegram } };
}

/** A transport whose sendPrompt resolves only when the test resolves it. */
function deferredTransport(): { transport: IKiroTransport; resolve: (v: string) => void; reject: (e: Error) => void; sendPrompt: ReturnType<typeof vi.fn> } {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const sendPrompt = vi.fn().mockReturnValue(new Promise<string>((res, rej) => { resolve = res; reject = rej; }));
  const transport = {
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt,
    resetSession: vi.fn().mockResolvedValue(undefined),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    get isReady() { return true; },
    get contextPercent() { return -1; },
    get answerOnly() { return ""; },
    get toolCallsSucceeded() { return 0; },
    get intermediateDeliveredText() { return ""; },
  } as unknown as IKiroTransport;
  return { transport, resolve, reject, sendPrompt };
}

async function tick(): Promise<void> {
  await new Promise(r => setTimeout(r, 1));
}

describe("Spin — #1611 Dreamy quarantine and late-result fencing", () => {
  let spin: Spin;

  beforeEach(() => {
    spin = new Spin();
    setUserRegistryOverride({
      users: [makeUser("aksika", "master", 111)],
      byPlatformId: new Map([["telegram:111", makeUser("aksika", "master", 111)]]),
      byUserId: new Map([["aksika", makeUser("aksika", "master", 111)]]),
    });
  });

  afterEach(() => {
    setUserRegistryOverride(null);
  });

  it("a quarantined generation is inert: its late result writes no memory and fires no step callback", async () => {
    const { transport, resolve } = deferredTransport();
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
    const onStepComplete = vi.fn();

    const session = spin.allocateDreamySession("Sleep quarantine test");
    const run = spin.spin({
      type: "D", prompt: "p1", sessionId: session.id,
      settlementOwner: "spin", await: true, candidatePolicy: "configured-only",
      onStepComplete,
    });
    await tick(); // transport attached, send in flight

    // Quarantine mid-execution — exactly like the sleep pump on a provider timeout.
    expect(spin.finalizeExactSession(session.id, "aksika", "provider_timeout")).toBe(true);
    expect(session.status).toBe("ended");
    expect(runtime.session).toHaveBeenCalledWith("dreamy", undefined, { candidatePolicy: "configured-only" });
    expect(session.candidatePolicy).toBe("configured-only");

    // The transport settles late, ignoring cancellation.
    resolve("late provider result");
    await run;

    expect(memory.recordMessage, "a late result after quarantine must not write memory").not.toHaveBeenCalled();
    expect(onStepComplete, "a late result after quarantine must not fire step callbacks").not.toHaveBeenCalled();
    expect(session.status, "the quarantined session stays ended").toBe("ended");
  });

  it("repeated quarantine is harmless (idempotent) and returns false for a missing/foreign session", () => {
    const session = spin.allocateDreamySession("Sleep quarantine test");
    expect(spin.finalizeExactSession(session.id, "aksika", "provider_timeout")).toBe(true);
    expect(spin.finalizeExactSession(session.id, "aksika", "provider_timeout")).toBe(true);
    expect(spin.finalizeExactSession("missing-session", "aksika", "provider_timeout")).toBe(false);
    expect(spin.finalizeExactSession(session.id, "adrika", "provider_timeout")).toBe(false);
  });

  it("conflicting candidate-policy reuse fails closed — a configured-only session is never broadened", async () => {
    const transport = deferredTransport();
    transport.resolve("ok");
    const runtime = {
      session: vi.fn().mockResolvedValue({
        sendPrompt: transport.sendPrompt,
        destroy: vi.fn(),
        get isReady() { return true; },
        get transport() { return transport.transport; },
      }),
    };
    spin.setRuntime(runtime as any);

    const session = spin.allocateDreamySession("Sleep policy test");
    await spin.spin({
      type: "D", prompt: "p1", sessionId: session.id,
      settlementOwner: "spin", await: true, candidatePolicy: "configured-only",
    });
    expect(session.candidatePolicy).toBe("configured-only");

    await expect(
      spin.spin({
        type: "D", prompt: "p2", sessionId: session.id,
        settlementOwner: "spin", await: true, candidatePolicy: "fallback-chain",
      }),
    ).rejects.toThrow(/conflicting reuse/);
    expect(runtime.session, "the reused transport must not be recreated").toHaveBeenCalledTimes(1);
  });

  it("two healthy steps share one session transport; terminal cleanup finalizes exactly once", async () => {
    const { transport, resolve } = deferredTransport();
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

    const session = spin.allocateDreamySession("Sleep continuity test");
    const step1 = spin.spin({
      type: "D", prompt: "p1", sessionId: session.id,
      settlementOwner: "spin", await: true, candidatePolicy: "configured-only",
    });
    await tick();
    resolve("step one");
    await step1;

    const step2 = spin.spin({
      type: "D", prompt: "p2", sessionId: session.id,
      settlementOwner: "spin", await: true, candidatePolicy: "configured-only",
    });
    await tick();
    resolve("step two");
    await step2;

    // One transport for the whole cycle — the second spin reused it.
    expect(runtime.session).toHaveBeenCalledTimes(1);
    expect(session.status, "healthy session survives the cycle").toBe("ready");
    expect(session.activeExecutionId).toBeUndefined();

    // Normal cycle-end cleanup finalizes the named session once.
    expect(spin.finalizeExactSession(session.id, "aksika", "cycle_end")).toBe(true);
    expect(spin.finalizeExactSession(session.id, "aksika", "cycle_end")).toBe(true);
    expect(session.status).toBe("ended");
    expect(memory.recordMessage).toHaveBeenCalledTimes(4); // user+assistant per healthy step
  });
});
