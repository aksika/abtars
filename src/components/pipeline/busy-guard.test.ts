import { describe, it, expect, vi, afterEach } from "vitest";
import { busyGuardMiddleware } from "./busy-guard.js";
import type { ManagedSession } from "../spin-types.js";

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "1_A_01", userId: "master", platform: "tg", chatId: 100,
    delivery: "simple", active: true, status: "ready",
    idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
    log: [], shortIndex: 1,
    busy: false, queue: [], fullMode: false, pendingStart: false, seen: false,
    compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    ...overrides,
  };
}

function makeCtx(sessionOverrides: Partial<ManagedSession> = {}, overrides: Record<string, unknown> = {}) {
  return {
    msg: { channelId: "100", threadId: undefined, platform: "tg", ...overrides },
    adapter: { sendMessage: vi.fn().mockResolvedValue(1) },
    deps: {
      transport: { sendInterrupt: vi.fn() },
      sessionManager: { getActiveSessionId: () => "1_A_01" },
    },
    text: (overrides.text as string) ?? "hello",
    handled: false,
    _session: makeSession(sessionOverrides),
  } as any;
}

async function mockSpin(session: ManagedSession) {
  const spinMod = await import("../spin.js");
  vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session);
}

async function mockSpinInterrupt() {
  const spinMod = await import("../spin.js");
  const spy = vi.spyOn(spinMod.spin, "interruptSession").mockResolvedValue(undefined);
  return { spy, spinMod };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("busyGuardMiddleware", () => {
  it("passes through when not busy", async () => {
    const ctx = makeCtx({ busy: false });
    await mockSpin(ctx._session);
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(next).toHaveBeenCalled();
    expect(ctx.handled).toBe(false);
  });

  it("queues message when busy", async () => {
    const ctx = makeCtx({ busy: true });
    await mockSpin(ctx._session);
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.adapter.sendMessage).not.toHaveBeenCalled();
    expect(ctx._session.queue).toHaveLength(1);
  });

  it("shows coffee message when compacting", async () => {
    const ctx = makeCtx({ busy: true, compacting: true });
    await mockSpin(ctx._session);
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(ctx.adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("coffee"), expect.any(Object));
  });

  it("bare wait interrupts through the session-aware Spin operation (legacy compat)", async () => {
    const ctx = makeCtx({ busy: true }, { text: "wait" });
    ctx.text = "wait";
    await mockSpin(ctx._session);
    const { spy } = await mockSpinInterrupt();
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(spy).toHaveBeenCalledWith("1_A_01", ctx.deps.transport, "operator");
    expect(ctx.deps.transport.sendInterrupt).not.toHaveBeenCalled();
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("/stop interrupts the busy session through the session-aware Spin operation (#1534)", async () => {
    const ctx = makeCtx({ busy: true }, { text: "/stop" });
    ctx.text = "/stop";
    await mockSpin(ctx._session);
    const { spy } = await mockSpinInterrupt();
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(spy).toHaveBeenCalledWith("1_A_01", ctx.deps.transport, "operator");
    expect(ctx.deps.transport.sendInterrupt).not.toHaveBeenCalled();
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("skips generic notification when ctx.deferReply is set", async () => {
    const ctx = makeCtx({ busy: true });
    await mockSpin(ctx._session);
    ctx.deferReply = true;
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(ctx.handled).toBe(true);
    expect(ctx.adapter.sendMessage).not.toHaveBeenCalled();
    expect(ctx._session.queue).toHaveLength(1);
  });

  // #1724: trusted scheduled-announcement events use an immediate, no-queue
  // admission policy — a busy Main session rejects without queue mutation so
  // the Kanban delivery poll keeps ownership of retry semantics.
  it("rejects a trusted scheduled announcement on a busy session without queueing (#1724)", async () => {
    const ctx = makeCtx({ busy: true });
    ctx.msg = { ...ctx.msg, internal: { kind: "scheduled_announcement", eventId: "scheduled-card:12", cardId: 12 } };
    await mockSpin(ctx._session);
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(ctx._session.queue).toHaveLength(0);
    expect(ctx.adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("passes a trusted scheduled announcement through when the session is not busy", async () => {
    const ctx = makeCtx({ busy: false });
    ctx.msg = { ...ctx.msg, internal: { kind: "scheduled_announcement", eventId: "scheduled-card:12", cardId: 12 } };
    await mockSpin(ctx._session);
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(next).toHaveBeenCalled();
    expect(ctx.handled).toBe(false);
  });
});
