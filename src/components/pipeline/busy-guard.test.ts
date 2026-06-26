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

  it("bare wait interrupts and stops (legacy compat)", async () => {
    const ctx = makeCtx({ busy: true }, { text: "wait" });
    ctx.text = "wait";
    await mockSpin(ctx._session);
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(ctx.deps.transport.sendInterrupt).toHaveBeenCalled();
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
});
