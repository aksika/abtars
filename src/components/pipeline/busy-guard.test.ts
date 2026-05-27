import { describe, it, expect, vi } from "vitest";
import { busyGuardMiddleware } from "./busy-guard.js";
import { SessionRegistry } from "../session-registry.js";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const sessions = new SessionRegistry();
  return {
    msg: { sessionKey: "master:tg", channelId: "100", threadId: undefined, ...overrides },
    adapter: { sendMessage: vi.fn().mockResolvedValue(1) },
    deps: { sessions, transport: { sendInterrupt: vi.fn() } },
    text: (overrides.text as string) ?? "hello",
    handled: false,
  } as any;
}

describe("busyGuardMiddleware", () => {
  it("passes through when not busy", async () => {
    const ctx = makeCtx();
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(next).toHaveBeenCalled();
    expect(ctx.handled).toBe(false);
  });

  it("queues message when busy", async () => {
    const ctx = makeCtx();
    ctx.deps.sessions.getOrCreate("master:tg").busy = true;
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.adapter.sendMessage).not.toHaveBeenCalled();
    expect(ctx.deps.sessions.get("master:tg")?.queue).toHaveLength(1);
  });

  it("shows coffee message when compacting", async () => {
    const ctx = makeCtx();
    const entry = ctx.deps.sessions.getOrCreate("master:tg");
    entry.busy = true;
    entry.compacting = true;
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(ctx.adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("coffee"), expect.any(Object));
  });

  it("bare wait interrupts and stops (legacy compat)", async () => {
    const ctx = makeCtx({ text: "wait" });
    ctx.text = "wait";
    ctx.deps.sessions.getOrCreate("master:tg").busy = true;
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(ctx.deps.transport.sendInterrupt).toHaveBeenCalled();
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("skips generic notification when ctx.deferReply is set", async () => {
    const ctx = makeCtx();
    ctx.deps.sessions.getOrCreate("master:tg").busy = true;
    ctx.deferReply = true;
    const next = vi.fn();
    await busyGuardMiddleware(ctx, next);
    expect(ctx.handled).toBe(true);
    expect(ctx.adapter.sendMessage).not.toHaveBeenCalled();
    // Still queued
    expect(ctx.deps.sessions.get("master:tg")?.queue).toHaveLength(1);
  });
});
