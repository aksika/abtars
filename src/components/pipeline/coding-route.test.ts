/**
 * coding-route.test.ts — #1635 routing boundary tests.
 *
 * Proves the route claims coding-owned input before the generic command
 * handlers, busy guards, and BeforeMessage; that global commands pass through;
 * and that non-coding sessions are untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessageContext, type MessageContext } from "./middleware.js";
import { codingRouteMiddleware, setCodingRouteService } from "./coding-route.js";
import type { PiCodingSessionService } from "../pi-executor/pi-coding-session-service.js";

function makeMsg(overrides = {}) {
  return {
    platform: "telegram", channelId: "100", userId: "usr-1", senderId: "42",
    senderName: "Test", text: "hello", timestamp: Date.now(), isGroup: false, isVoice: false,
    ...overrides,
  } as never;
}

function makeAdapter() {
  return { sendMessage: vi.fn().mockResolvedValue(1), chunkResponse: (t: string) => [t] } as never;
}

function makeDeps() {
  return { transport: {} } as never;
}

function makeCtx(sessionId: string | undefined, text: string): MessageContext {
  const ctx = createMessageContext(makeMsg({ text }), makeAdapter(), makeDeps());
  if (sessionId) {
    ctx.sessionId = sessionId;
    ctx.session = { id: sessionId } as MessageContext["session"];
  }
  return ctx;
}

const svc = {
  getSession: vi.fn(),
  startTurn: vi.fn(),
  followUp: vi.fn(),
  steer: vi.fn(),
  stop: vi.fn(),
  passThrough: vi.fn(),
  compactSession: vi.fn(),
};

const idleRec = { sessionId: "coding-1", ownerPrincipal: "usr-1", state: "idle" };
const runningRec = { sessionId: "coding-1", ownerPrincipal: "usr-1", state: "running" };

beforeEach(() => {
  vi.resetAllMocks();
  svc.getSession.mockReturnValue(null);
  svc.startTurn.mockResolvedValue({ kind: "started" });
  svc.followUp.mockResolvedValue({ kind: "started" });
  svc.steer.mockResolvedValue({ kind: "started" });
  svc.stop.mockResolvedValue(true);
  svc.passThrough.mockResolvedValue({ kind: "started" });
  svc.compactSession.mockResolvedValue({ ok: true, message: "ok" });
  setCodingRouteService(svc as never as PiCodingSessionService);
});

afterEach(() => {
  setCodingRouteService(null);
});

describe("codingRouteMiddleware #1635", () => {
  it("claims ordinary text on an idle coding session as a turn start", async () => {
    svc.getSession.mockReturnValue(idleRec);
    const ctx = makeCtx("coding-1", "implement the widget");
    await codingRouteMiddleware(ctx, async () => { throw new Error("must not continue"); });
    expect(ctx.handled).toBe(true);
    expect(svc.startTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "coding-1", text: "implement the widget" }));
  });

  it("routes ordinary text on a running coding session to follow_up", async () => {
    svc.getSession.mockReturnValue(runningRec);
    const ctx = makeCtx("coding-1", "keep going");
    await codingRouteMiddleware(ctx, async () => { throw new Error("must not continue"); });
    expect(ctx.handled).toBe(true);
    expect(svc.followUp).toHaveBeenCalledWith("coding-1", "keep going", "usr-1");
    expect(svc.startTurn).not.toHaveBeenCalled();
  });

  it("claims /stop and /ctrlc for the coding session (not the generic handler)", async () => {
    svc.getSession.mockReturnValue(runningRec);
    for (const cmd of ["/stop", "/ctrlc"]) {
      const ctx = makeCtx("coding-1", cmd);
      await codingRouteMiddleware(ctx, async () => { throw new Error("must not continue"); });
      expect(ctx.handled).toBe(true);
    }
    expect(svc.stop).toHaveBeenCalledTimes(2);
  });

  it("claims /steer and /compact for the coding session", async () => {
    svc.getSession.mockReturnValue(runningRec);
    const steerCtx = makeCtx("coding-1", "/steer focus on tests");
    await codingRouteMiddleware(steerCtx, async () => { throw new Error("must not continue"); });
    expect(steerCtx.handled).toBe(true);
    expect(svc.steer).toHaveBeenCalledWith("coding-1", "focus on tests", "usr-1");

    const compactCtx = makeCtx("coding-1", "/compact");
    await codingRouteMiddleware(compactCtx, async () => { throw new Error("must not continue"); });
    expect(compactCtx.handled).toBe(true);
    expect(svc.compactSession).toHaveBeenCalledWith("coding-1", undefined, "usr-1");
  });

  it("claims // pass-through with one slash stripped", async () => {
    svc.getSession.mockReturnValue(idleRec);
    const ctx = makeCtx("coding-1", "//compact");
    await codingRouteMiddleware(ctx, async () => { throw new Error("must not continue"); });
    expect(ctx.handled).toBe(true);
    expect(svc.passThrough).toHaveBeenCalledWith("coding-1", "/compact", "usr-1");
  });

  it("passes global /coding and /session commands to the registry", async () => {
    svc.getSession.mockReturnValue(idleRec);
    for (const cmd of ["/coding status", "/session", "/session end 2"]) {
      let continued = false;
      const ctx = makeCtx("coding-1", cmd);
      await codingRouteMiddleware(ctx, async () => { continued = true; });
      expect(continued).toBe(true);
      expect(ctx.handled).toBe(false);
    }
  });

  it("passes unrelated commands through", async () => {
    svc.getSession.mockReturnValue(idleRec);
    let continued = false;
    const ctx = makeCtx("coding-1", "/status");
    await codingRouteMiddleware(ctx, async () => { continued = true; });
    expect(continued).toBe(true);
    expect(ctx.handled).toBe(false);
  });

  it("does nothing for sessions that are not coding sessions", async () => {
    svc.getSession.mockReturnValue(null);
    let continued = false;
    const ctx = makeCtx("main-1", "ordinary message");
    await codingRouteMiddleware(ctx, async () => { continued = true; });
    expect(continued).toBe(true);
    expect(ctx.handled).toBe(false);
  });

  it("does nothing when no coding service is wired", async () => {
    setCodingRouteService(null);
    let continued = false;
    const ctx = makeCtx("coding-1", "anything");
    await codingRouteMiddleware(ctx, async () => { continued = true; });
    expect(continued).toBe(true);
  });

  it("replies with a bounded retry response while starting", async () => {
    svc.getSession.mockReturnValue({ ...idleRec, state: "starting" });
    svc.startTurn.mockResolvedValue({ kind: "retry", reason: "Session is starting; retry shortly" });
    const ctx = makeCtx("coding-1", "hello");
    await codingRouteMiddleware(ctx, async () => { throw new Error("must not continue"); });
    expect(ctx.handled).toBe(true);
  });

  it("never allows a non-owner message into the coding session", async () => {
    svc.getSession.mockReturnValue(null); // owner check failed
    const ctx = makeCtx("coding-1", "hello");
    let continued = false;
    await codingRouteMiddleware(ctx, async () => { continued = true; });
    expect(continued).toBe(true);
  });
});
