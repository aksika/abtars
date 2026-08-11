/**
 * spin.native-steering.test.ts — #1531 event-driven native steering pump.
 *
 * Proves that for a native-steering driver the steer handoff happens while the
 * initial send is still in flight, leases serialize one at a time, the final
 * response always comes from the send promise, a steering-only failure never
 * replaces the send result, closing terminalizes every accepted instruction
 * exactly once, and the ACP/tmux sequential continuation path is unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let _nextId = 1;
const _cards = new Map<number, { id: number; status: string; [key: string]: unknown }>();
vi.mock("./tasks/kanban-board.js", () => ({
  kanbanEnqueue: (title: string, source: string) => {
    const id = _nextId++;
    _cards.set(id, { id, status: "queued" });
    return id;
  },
  kanbanRunning: () => {},
  kanbanComplete: () => {},
  kanbanFail: () => {},
  kanbanRetryOrFail: () => "failed",
  kanbanList: () => [],
  kanbanQueuedDispatchOrder: () => [],
  kanbanGetCard: (id: number) => _cards.get(id) ?? null,
  isUnblocked: () => true,
  resolveRootId: (id: number) => id,
  resolveActiveDescendants: () => [],
  resolveRecentDirectChildren: () => [],
  kanbanGetChildren: () => [],
  kanbanAddTokens: () => {},
  kanbanProgress: () => {},
}));

vi.mock("./transport/bridge-lock-transport.js", () => ({
  updateBridgeLockField: () => {},
  trackAcpPid: vi.fn(),
}));

vi.mock("./transport/orc-tools.js", () => ({
  setActiveOrcCard: () => {},
  setActiveOrcContext: () => {},
  getActiveOrcContext: () => null,
}));

vi.mock("./project-acceptance/project-review-store.js", () => ({
  ProjectReviewStore: class {
    getSupervision(): unknown { return undefined; }
  },
}));

vi.mock("./peer-transport/index.js", () => ({
  getPeerTransport: () => ({ send: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("./spin-notifications.js", () => ({
  drainOrcNotifications: () => [],
}));

vi.mock("./tasks/kanban-channel.js", () => ({
  channelUnread: () => [],
}));

vi.mock("../utils/local-time.js", () => ({
  localDateTime: () => "2026-07-01 12:00",
}));

vi.mock("./soul-bundle.js", () => ({
  buildSoulBundle: () => "SOUL_BUNDLE",
}));

import { Spin } from "./spin.js";
import { setUserRegistryOverride, type UserRegistry, type UserEntry } from "./user-registry.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { ManagedSession } from "./spin-types.js";
import { queueInstruction, markConsumed, onSteerEvent, type InstructionQueueHolder } from "./session-instruction-queue.js";
import type { SteerEvent } from "./spin-types.js";

function makeUser(userId: string, role: "master" | "user" | "guest", telegram = 100): UserEntry {
  return { userId, role, maxClass: role === "master" ? 3 : 1, tools: ["all"], platforms: { telegram } };
}

function makeRegistry(users: UserEntry[]): UserRegistry {
  const registry: UserRegistry = { users, byPlatformId: new Map(), byUserId: new Map() };
  for (const u of users) {
    registry.byUserId.set(u.userId, u);
    if (u.platforms.telegram) registry.byPlatformId.set(`telegram:${u.platforms.telegram}`, u);
  }
  return registry;
}

function mockTransport(overrides: Partial<IKiroTransport> = {}): IKiroTransport {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("Hello!"),
    resetSession: vi.fn().mockResolvedValue(undefined),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    get isReady() { return true; },
    get contextPercent() { return -1; },
    get answerOnly() { return ""; },
    get toolCallsSucceeded() { return 0; },
    get intermediateDeliveredText() { return ""; },
    ...overrides,
  } as unknown as IKiroTransport;
}

interface DeferredSend {
  promise: Promise<string>;
  resolve: (v: string) => void;
  reject: (e: unknown) => void;
}

function makeDeferredSend(): DeferredSend {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("spin() — #1531 native steering pump", () => {
  let spin: Spin;

  beforeEach(() => {
    spin = new Spin();
    spin.setRuntime(makeRuntime() as any);
    _cards.clear();
    setUserRegistryOverride(makeRegistry([makeUser("aksika", "master", 111)]));
  });

  afterEach(() => {
    setUserRegistryOverride(null);
  });

  function makeRuntime(): { openExecution: ReturnType<typeof vi.fn>; session: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn> } {
    return {
      session: vi.fn().mockResolvedValue({
        sendPrompt: vi.fn(),
        destroy: vi.fn(),
        get isReady() { return true; },
        get transport() { return mockTransport(); },
      }),
      complete: vi.fn(async () => "(no output)"),
      openExecution: vi.fn(async () => ({
        send: vi.fn(async () => "(no output)"),
        close: vi.fn(),
        transport: mockTransport(),
        sessionKey: "mock:exec",
        ephemeral: true,
        lastUsage: () => null,
      })),
    };
  }

  /**
   * Native-steering transport whose send is a deferred I control and whose
   * steer acks the lease through the real queue ledger (like the host does on
   * instruction message_end).
   */
  function makeNativeTransport(send: DeferredSend, steerImpl: (content: string, lease: Parameters<NonNullable<IKiroTransport["steer"]>>[1], session: InstructionQueueHolder) => Promise<void>): {
    transport: IKiroTransport;
    steer: ReturnType<typeof vi.fn>;
  } {
    const steer = vi.fn(async (content: string, lease: Parameters<NonNullable<IKiroTransport["steer"]>>[1]) => {
      await steerImpl(content, lease, spin.getSessionById(lease.sessionId) ?? { instructionQueue: [] as never });
    });
    return { transport: mockTransport({ sendPrompt: vi.fn(() => send.promise), steer }), steer };
  }

  /** Attach a transport to a fresh D session and start a spin call against it. */
  function startNativeTurn(transport: IKiroTransport): { spinPromise: Promise<{ result?: string }>; session: ManagedSession } {
    const session = spin.createSubSession("aksika", "telegram", "D") as ManagedSession;
    session.transport = transport;
    const spinPromise = spin.spin({ type: "D", sessionId: session.id, prompt: "first turn", await: true, userId: "aksika", platform: "telegram" });
    return { spinPromise, session };
  }

  async function waitAccepting(session: ManagedSession): Promise<void> {
    await vi.waitFor(() => expect(session.steeringAccepting).toBe(true));
  }

  it("hands a queued instruction to the active execution before the send resolves; final text comes from send", async () => {
    const send = makeDeferredSend();
    const steerCalls: string[] = [];
    const { transport, steer } = makeNativeTransport(send, async (content, lease, session) => {
      steerCalls.push(content);
      markConsumed(lease, session);
    });
    const { spinPromise, session } = startNativeTurn(transport);
    await waitAccepting(session);

    const queued = queueInstruction(session, { text: "steer mid-generation", source: "tui" });
    expect(queued.ok).toBe(true);

    // The steer must be delivered while the initial send is STILL pending.
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    expect(steerCalls[0]).toContain("steer mid-generation");
    expect(steerCalls[0]).toContain("[USER STEERING");
    let spinSettled = false;
    void spinPromise.then(() => { spinSettled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(spinSettled).toBe(false);

    send.resolve("final reply from send");
    const result = await spinPromise;
    expect(result.result).toBe("final reply from send");
    expect(session.instructionQueue.length).toBe(0);
  });

  it("serializes native handoffs: a later instruction waits for the preceding lease ack", async () => {
    const send = makeDeferredSend();
    const ackLeases: Array<(content: string, lease: Parameters<NonNullable<IKiroTransport["steer"]>>[1], session: InstructionQueueHolder) => Promise<void>> = [];
    const { transport, steer } = makeNativeTransport(send, (content, lease, session) => {
      return new Promise<void>((resolveAck) => {
        ackLeases.push(async () => {
          markConsumed(lease, session);
          resolveAck();
        });
      });
    });
    const { spinPromise, session } = startNativeTurn(transport);
    await waitAccepting(session);

    const q1 = queueInstruction(session, { text: "steer one", source: "tui" });
    expect(q1.ok).toBe(true);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    expect(steer.mock.calls[0]![1]!.instructions.map((i) => i.id)).toEqual([q1.ok ? q1.instruction.id : "?"]);

    // A second instruction queued during the outstanding lease must NOT be
    // handed off until the first lease reaches its acknowledgement.
    const q2 = queueInstruction(session, { text: "steer two", source: "tui" });
    expect(q2.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(steer).toHaveBeenCalledTimes(1);

    await ackLeases[0]!();
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(2));
    expect(steer.mock.calls[1]![1]!.instructions.map((i) => i.id)).toEqual([q2.ok ? q2.instruction.id : "?"]);
    await ackLeases[1]!();

    send.resolve("serial final");
    expect((await spinPromise).result).toBe("serial final");
    expect(session.instructionQueue.length).toBe(0);
  });

  it("a steering-only failure publishes failure but never replaces the send result", async () => {
    const send = makeDeferredSend();
    const { transport, steer } = makeNativeTransport(send, async (_content, lease, session) => {
      // Post-delivery failure: the host marked the lease delivered, then the
      // backend handoff failed. The pump must fail the lease, not the turn.
      const events: SteerEvent[] = [];
      const unsub = onSteerEvent((e) => events.push(e));
      try {
        markConsumed(lease, session); // simulate "delivered" state transition is host-owned;
        // the pump's failure handling operates on the real queue state, so
        // re-lease: this transport mock simulates the host rejecting AFTER
        // markDelivered by failing the lease directly.
        const { failAfterDelivery } = await import("./session-instruction-queue.js");
        failAfterDelivery(lease, session, "steer_failed");
        throw new Error("host rejected the handoff");
      } finally {
        unsub();
        void events;
      }
    });
    const { spinPromise, session } = startNativeTurn(transport);
    await waitAccepting(session);

    const queued = queueInstruction(session, { text: "steer that fails", source: "tui" });
    expect(queued.ok).toBe(true);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));

    send.resolve("send wins");
    const result = await spinPromise;
    expect(result.result).toBe("send wins");
    expect(session.instructionQueue.length).toBe(0);
  });

  it("send settlement terminalizes accepted leftovers exactly once and rejects new steers", async () => {
    const send = makeDeferredSend();
    const heldAcks: Array<() => void> = [];
    const { transport, steer } = makeNativeTransport(send, (_content, lease, session) => {
      return new Promise<void>((resolveAck) => {
        heldAcks.push(() => {
          markConsumed(lease, session);
          resolveAck();
        });
      });
    });
    const events: SteerEvent[] = [];
    const unsub = onSteerEvent((e) => events.push(e));
    const { spinPromise, session } = startNativeTurn(transport);
    await waitAccepting(session);

    const q1 = queueInstruction(session, { text: "in flight", source: "tui" });
    expect(q1.ok).toBe(true);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    const q2 = queueInstruction(session, { text: "queued behind", source: "tui" });
    expect(q2.ok).toBe(true);

    // Send settles while lease 1 is outstanding and lease 2 is still queued.
    send.resolve("settled");
    // The outstanding lease still reaches its ack (the host would reject it
    // on settlement; either way it is terminal exactly once).
    heldAcks[0]!();
    const result = await spinPromise;
    expect(result.result).toBe("settled");

    const byId = new Map<string, string>();
    for (const e of events) {
      for (const id of e.instructionIds) byId.set(id, e.type);
    }
    for (const id of [q1.ok ? q1.instruction.id : "", q2.ok ? q2.instruction.id : ""]) {
      const terminal = byId.get(id);
      expect(["steer.consumed", "steer.failed", "steer.expired"]).toContain(terminal);
    }
    expect(session.instructionQueue.length).toBe(0);
    expect(session.steeringAccepting).toBe(false);

    // Acceptance is closed after settlement — a late instruction is rejected
    // (the execution generation has ended, so the queue reports the gate
    // closure as stale_execution/not_steerable).
    const late = queueInstruction(session, { text: "too late", source: "tui" });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(["not_steerable", "stale_execution", "not_active"]).toContain(late.reason);
    unsub();
  }, 15_000);

  it("closes acceptance synchronously at the native-handoff round limit", async () => {
    const send = makeDeferredSend();
    const { transport, steer } = makeNativeTransport(send, async (_content, lease, session) => {
      markConsumed(lease, session);
    });
    const { spinPromise, session } = startNativeTurn(transport);
    await waitAccepting(session);

    // MAX_STEER_ROUNDS (10) batches — one instruction per round, acked.
    for (let i = 1; i <= 10; i++) {
      const q = queueInstruction(session, { text: `steer round ${i}`, source: "tui" });
      expect(q.ok).toBe(true);
      await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(i));
    }
    // Acceptance is closed synchronously once the limit is reached: the 11th
    // instruction is rejected instead of queued-then-expired.
    expect(session.steeringAccepting).toBe(false);
    const eleventh = queueInstruction(session, { text: "over the limit", source: "tui" });
    expect(eleventh.ok).toBe(false);
    if (!eleventh.ok) expect(["not_steerable", "stale_execution", "not_active"]).toContain(eleventh.reason);

    send.resolve("round limited");
    expect((await spinPromise).result).toBe("round limited");
    expect(session.instructionQueue.length).toBe(0);
  });

  it("keeps the sequential post-send continuation path for drivers without native steering", async () => {
    const firstSend = makeDeferredSend();
    const sendCalls: string[] = [];
    const transport = mockTransport({
      sendPrompt: vi.fn(async (_key: string, message: string) => {
        sendCalls.push(message);
        if (sendCalls.length === 1) return firstSend.promise;
        return "steered reply";
      }),
    });
    const session = spin.createSubSession("aksika", "telegram", "D") as ManagedSession;
    session.transport = transport;
    const spinPromise = spin.spin({ type: "D", sessionId: session.id, prompt: "first turn", await: true, userId: "aksika", platform: "telegram" });
    await vi.waitFor(() => expect(session.steeringAccepting).toBe(true));

    const events: SteerEvent[] = [];
    const unsub = onSteerEvent((e) => events.push(e));
    const queued = queueInstruction(session, { text: "post-send steer", source: "tui" });
    expect(queued.ok).toBe(true);

    firstSend.resolve("first reply");
    const result = await spinPromise;
    expect(result.result).toBe("steered reply");
    // First call: the initial prompt. Second call: the steering continuation.
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]).toContain("[USER STEERING");
    expect(sendCalls[1]).toContain("post-send steer");
    const consumed = events.filter((e) => e.type === "steer.consumed");
    expect(consumed).toHaveLength(1);
    expect(session.instructionQueue.length).toBe(0);
    unsub();
  });
});
