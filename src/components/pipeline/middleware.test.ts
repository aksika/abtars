import { describe, it, expect, vi } from "vitest";
import { runPipeline, createMessageContext, type Middleware, type MessageContext } from "./middleware.js";

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
