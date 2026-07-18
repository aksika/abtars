import { describe, it, expect, vi, afterEach } from "vitest";
import { runPipeline, createMessageContext, type Middleware, type MessageContext } from "./middleware.js";
import type { ManagedSession } from "../spin-types.js";

function makeMsg(overrides = {}) {
  return { platform: "telegram", channelId: "100", userId: "master", senderId: "42", senderName: "Test", text: "hello", timestamp: Date.now(), isGroup: false, isVoice: false, ...overrides } as any;
}
function makeAdapter() { return { sendMessage: vi.fn().mockResolvedValue(1), chunkResponse: (t: string) => [t] } as any; }
function makeDeps() { return { transport: {} } as any; }

describe("runPipeline", () => {
  it("runs middlewares in order", async () => {
    const order: number[] = [];
    const mw1: Middleware = async (_ctx, next) => { order.push(1); await next(); };
    const mw2: Middleware = async (_ctx, next) => { order.push(2); await next(); };
    const ctx = createMessageContext(makeMsg(), makeAdapter(), makeDeps());
    await runPipeline(ctx, [mw1, mw2]);
    expect(order).toEqual([1, 2]);
  });

  it("stops when ctx.handled is set", async () => {
    const order: number[] = [];
    const mw1: Middleware = async (ctx) => { order.push(1); ctx.handled = true; };
    const mw2: Middleware = async (_ctx, next) => { order.push(2); await next(); };
    const ctx = createMessageContext(makeMsg(), makeAdapter(), makeDeps());
    await runPipeline(ctx, [mw1, mw2]);
    expect(order).toEqual([1]);
    expect(ctx.handled).toBe(true);
  });

  it("handles empty middleware list", async () => {
    const ctx = createMessageContext(makeMsg(), makeAdapter(), makeDeps());
    await runPipeline(ctx, []);
    expect(ctx.handled).toBe(false);
  });
});

describe("createMessageContext", () => {
  it("passes userId from message", () => {
    const ctx = createMessageContext(makeMsg({ userId: "aksika" }), makeAdapter(), makeDeps());
    expect(ctx.userId).toBe("aksika");
  });

  it("uses userId directly from message", () => {
    const ctx = createMessageContext(makeMsg({ userId: "master" }), makeAdapter(), makeDeps());
    expect(ctx.userId).toBe("master");
  });

  it("parses chatId from channelId", () => {
    const ctx = createMessageContext(makeMsg({ channelId: "42" }), makeAdapter(), makeDeps());
    expect(ctx.chatId).toBe(42);
  });
});

describe("pausedGuardMiddleware (#1347)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function makeCtx(sessionOverrides: Partial<ManagedSession> = {}, overrides: Record<string, unknown> = {}) {
    return {
      msg: { channelId: "100", threadId: undefined, platform: "tg", userId: "aksika", ...overrides },
      adapter: { sendMessage: vi.fn().mockResolvedValue(1), chunkResponse: (t: string) => [t] },
      deps: {},
      reply: vi.fn().mockResolvedValue(undefined),
      text: (overrides.text as string) ?? "hello",
      handled: false,
      _session: {
        id: "1_A_01", userId: "aksika", platform: "tg", chatId: 100,
        delivery: "simple", active: true, status: "ready",
        idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
        log: [], shortIndex: 1,
        busy: false, queue: [], fullMode: false, pendingStart: false, seen: false,
        compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
        ...sessionOverrides,
      },
    } as any;
  }

  async function mockSession(session: ManagedSession) {
    const spinMod = await import("../spin.js");
    vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue(session);
  }

  it("blocks non-command message when session is paused", async () => {
    const ctx = makeCtx({ status: "paused", shortIndex: 3 });
    await mockSession(ctx._session);
    const next = vi.fn();
    const { pausedGuardMiddleware } = await import("./paused-guard.js");
    await pausedGuardMiddleware(ctx, next);
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith("Session #3 is paused. Use /session resume or switch sessions.");
  });

  it("passes through when session is ready", async () => {
    const ctx = makeCtx({ status: "ready" });
    await mockSession(ctx._session);
    const next = vi.fn();
    const { pausedGuardMiddleware } = await import("./paused-guard.js");
    await pausedGuardMiddleware(ctx, next);
    expect(ctx.handled).toBe(false);
    expect(next).toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("passes through when session is busy but not paused", async () => {
    const ctx = makeCtx({ status: "ready", busy: true });
    await mockSession(ctx._session);
    const next = vi.fn();
    const { pausedGuardMiddleware } = await import("./paused-guard.js");
    await pausedGuardMiddleware(ctx, next);
    expect(ctx.handled).toBe(false);
    expect(next).toHaveBeenCalled();
  });
});
