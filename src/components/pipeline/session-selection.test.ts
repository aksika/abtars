import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sessionSelectionMiddleware } from "./session-selection.js";
import { setUserRegistryOverride } from "../user-registry.js";
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

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    msg: { channelId: "100", threadId: undefined, platform: "tg", text: "hello", userId: "master", targetSessionId: undefined, ...overrides.msg as any },
    adapter: { name: "tg", sendMessage: vi.fn().mockResolvedValue(1) },
    deps: { transport: {}, sessionManager: { getActiveSessionId: () => "1_A_01" } },
    userId: "master",
    handled: false,
    session: undefined,
    sessionId: undefined,
    ...overrides,
  } as any;
}

afterEach(() => { vi.restoreAllMocks(); setUserRegistryOverride(null); });

describe("sessionSelectionMiddleware", () => {
  beforeEach(() => {
    setUserRegistryOverride({ users: [{ userId: "master", role: "master", maxClass: 5, tools: [], platforms: {} }], byPlatformId: new Map(), byUserId: new Map() });
  });
  it("selects platform-local active session when no targetSessionId", async () => {
    const ctx = makeCtx();
    const session = makeSession();
    const spinMod = await import("../spin.js");
    vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue(session);
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(spinMod.spin.getActiveSession).toHaveBeenCalledWith("master", "tg");
    expect(ctx.session).toBe(session);
    expect(ctx.sessionId).toBe(session.id);
    expect(next).toHaveBeenCalled();
  });

  it("rejects targeted session from non-TUI adapter", async () => {
    const ctx = makeCtx({ msg: { targetSessionId: "1_B_02", platform: "tg" } });
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects targeted session from TUI adapter but wrong platform", async () => {
    const ctx = makeCtx({ adapter: { name: "tui" }, msg: { targetSessionId: "1_B_02", platform: "irc" } });
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects targeted session from non-master user", async () => {
    const ctx = makeCtx({ adapter: { name: "tui" }, msg: { targetSessionId: "1_B_02", platform: "tui" }, userId: "guest" });
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects targeted session that does not exist", async () => {
    const ctx = makeCtx({ adapter: { name: "tui" }, msg: { targetSessionId: "1_B_99", platform: "tui" } });
    const spinMod = await import("../spin.js");
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(undefined);
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects targeted session belonging to different user", async () => {
    const ctx = makeCtx({ adapter: { name: "tui" }, msg: { targetSessionId: "1_B_02", platform: "tui" } });
    const session = makeSession({ id: "1_B_02", userId: "other" });
    const spinMod = await import("../spin.js");
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session);
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects targeted session that is ended", async () => {
    const ctx = makeCtx({ adapter: { name: "tui" }, msg: { targetSessionId: "1_B_02", platform: "tui" } });
    const session = makeSession({ id: "1_B_02", userId: "master", status: "ended" });
    const spinMod = await import("../spin.js");
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session);
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(ctx.handled).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts valid targeted session from TUI master", async () => {
    const ctx = makeCtx({ adapter: { name: "tui" }, msg: { targetSessionId: "1_B_02", platform: "tui" } });
    const session = makeSession({ id: "1_B_02", userId: "master", platform: "tg" });
    const spinMod = await import("../spin.js");
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session);
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(ctx.handled).toBe(false);
    expect(ctx.session).toBe(session);
    expect(ctx.sessionId).toBe("1_B_02");
    expect(next).toHaveBeenCalled();
  });
});

describe("sessionSelectionMiddleware #1432 K routing", () => {
  const skillMod = { skillSessionManager: { resolveForInbound: vi.fn(), stop: vi.fn().mockResolvedValue(true) } };
  let spinMod: typeof import("../spin.js");

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../skill-session.js", () => skillMod);
    skillMod.skillSessionManager.resolveForInbound.mockClear();
    skillMod.skillSessionManager.stop.mockClear();
    setUserRegistryOverride({ users: [{ userId: "master", role: "master", maxClass: 5, tools: [], platforms: {} }], byPlatformId: new Map(), byUserId: new Map() });
    spinMod = await import("../spin.js");
  });

  afterEach(() => { vi.restoreAllMocks(); setUserRegistryOverride(null); });

  it("routes an exact matching K binding to the K session before A", async () => {
    const ctx = makeCtx({ userId: "adrika", msg: { channelId: "8385860222", platform: "telegram", userId: "adrika" } });
    const kSession = makeSession({ id: "1_K_01", userId: "adrika", platform: "telegram" });
    skillMod.skillSessionManager.resolveForInbound.mockReturnValue({ kind: "active", sessionId: "1_K_01", needsBootstrap: false });
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(kSession);
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(skillMod.skillSessionManager.resolveForInbound).toHaveBeenCalledWith({
      userId: "adrika", platform: "telegram", chatId: "8385860222", threadId: undefined,
    });
    expect(ctx.session).toBe(kSession);
    expect(ctx.sessionId).toBe("1_K_01");
    expect(next).toHaveBeenCalled();
  });

  it("falls back to A when no binding matches (wrong address)", async () => {
    const ctx = makeCtx({ userId: "adrika", msg: { channelId: "999", platform: "telegram", userId: "adrika" } });
    skillMod.skillSessionManager.resolveForInbound.mockReturnValue({ kind: "none" });
    const aSession = makeSession({ id: "1_A_01" });
    vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue(aSession);
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(ctx.session).toBe(aSession);
    expect(next).toHaveBeenCalled();
  });

  it("falls back to A after rehydration failure clears the binding", async () => {
    const ctx = makeCtx({ userId: "adrika", msg: { channelId: "8385860222", platform: "telegram", userId: "adrika" } });
    skillMod.skillSessionManager.resolveForInbound.mockReturnValue({ kind: "fallback_to_main" });
    const aSession = makeSession({ id: "1_A_01" });
    vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue(aSession);
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(ctx.session).toBe(aSession);
    expect(next).toHaveBeenCalled();
  });

  it("drops a stale K session that died out-of-band and selects A", async () => {
    const ctx = makeCtx({ userId: "adrika", msg: { channelId: "8385860222", platform: "telegram", userId: "adrika" } });
    skillMod.skillSessionManager.resolveForInbound.mockReturnValue({ kind: "active", sessionId: "1_K_01", needsBootstrap: false });
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(undefined);
    const aSession = makeSession({ id: "1_A_01" });
    vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue(aSession);
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(skillMod.skillSessionManager.stop).toHaveBeenCalled();
    expect(ctx.session).toBe(aSession);
    expect(next).toHaveBeenCalled();
  });

  it("keeps explicit TUI targeting precedence over K bindings", async () => {
    const ctx = makeCtx({ adapter: { name: "tui" }, msg: { targetSessionId: "1_B_02", platform: "tui" } });
    const session = makeSession({ id: "1_B_02", userId: "master", platform: "tg" });
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session);
    const next = vi.fn();
    await sessionSelectionMiddleware(ctx, next);
    expect(skillMod.skillSessionManager.resolveForInbound).not.toHaveBeenCalled();
    expect(ctx.session).toBe(session);
    expect(next).toHaveBeenCalled();
  });
});
