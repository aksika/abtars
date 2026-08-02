import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { commandMiddleware } from "./commands.js";
import { handleStop } from "../commands/handlers-system.js";
import type { ManagedSession } from "../spin-types.js";
import { setUserRegistryOverride, type UserRegistry, type UserEntry } from "../user-registry.js";

vi.mock("../commands/index.js", () => ({
  handleCommand: vi.fn().mockResolvedValue(true),
}));
import { handleCommand } from "../commands/index.js";

function makeUser(userId: string, role: "master" | "user" | "guest"): UserEntry {
  return { userId, role, maxClass: role === "master" ? 3 : 1, tools: ["all"], platforms: {} };
}

function makeRegistry(users: UserEntry[]): UserRegistry {
  const registry: UserRegistry = { users, byPlatformId: new Map(), byUserId: new Map() };
  for (const u of users) registry.byUserId.set(u.userId, u);
  return registry;
}

function makeSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "1_A_01", userId: "aksika", platform: "tui", chatId: 100,
    delivery: "simple", active: true, status: "ready",
    idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
    log: [], shortIndex: 1,
    busy: false, queue: [], fullMode: false, pendingStart: false, seen: false,
    compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    ...overrides,
  };
}

function makeCtx(session: ManagedSession | undefined, text: string) {
  return {
    msg: { userId: "aksika", platform: "tui", channelId: "100", threadId: undefined, isGroup: false, isVoice: false, text, timestamp: Date.now(), senderId: "aksika", senderName: "aksika" },
    deps: {
      transport: { sendInterrupt: vi.fn().mockResolvedValue(undefined) },
      config: {}, startedAt: Date.now(),
      memoryRuntime: null, memoryConfig: null, nlmConfig: null,
      idleSave: vi.fn(), updateCtxStart: vi.fn(), conversationBuffer: undefined,
      sessionManager: { getActiveSessionId: vi.fn() },
    },
    text,
    handled: false,
    sessionId: session?.id,
    adapter: {},
    reply: vi.fn().mockResolvedValue(undefined),
  } as any;
}

beforeEach(() => {
  setUserRegistryOverride(makeRegistry([makeUser("aksika", "master")]));
  vi.mocked(handleCommand).mockClear();
});

afterEach(() => { setUserRegistryOverride(null); vi.restoreAllMocks(); });

describe("commandMiddleware interrupt routing (#1534)", () => {
  it("does not pre-interrupt /stop on a busy session — the handler owns the interrupt", async () => {
    const spinMod = await import("../spin.js");
    const interrupt = vi.spyOn(spinMod.spin, "interruptSession").mockResolvedValue(undefined);
    const session = makeSession({ busy: true });
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session);
    const ctx = makeCtx(session, "/stop");

    await commandMiddleware(ctx, vi.fn());

    expect(interrupt).not.toHaveBeenCalled();
    expect(handleCommand).toHaveBeenCalledWith("/stop", expect.objectContaining({ sessionKey: "1_A_01" }));
    expect(ctx.deps.transport.sendInterrupt).not.toHaveBeenCalled();
  });

  it("pre-interrupts a busy effective session for /reset via the session-aware Spin operation", async () => {
    const spinMod = await import("../spin.js");
    const interrupt = vi.spyOn(spinMod.spin, "interruptSession").mockResolvedValue(undefined);
    const session = makeSession({ busy: true });
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session);
    const ctx = makeCtx(session, "/reset");

    await commandMiddleware(ctx, vi.fn());

    expect(interrupt).toHaveBeenCalledOnce();
    expect(interrupt).toHaveBeenCalledWith("1_A_01", ctx.deps.transport, "operator");
    expect(ctx.deps.transport.sendInterrupt).not.toHaveBeenCalled();
    expect(handleCommand).toHaveBeenCalledWith("/reset", expect.anything());
  });

  it("does not interrupt an idle session for /reset", async () => {
    const spinMod = await import("../spin.js");
    const interrupt = vi.spyOn(spinMod.spin, "interruptSession").mockResolvedValue(undefined);
    const session = makeSession({ busy: false });
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session);
    const ctx = makeCtx(session, "/reset");

    await commandMiddleware(ctx, vi.fn());

    expect(interrupt).not.toHaveBeenCalled();
    expect(handleCommand).toHaveBeenCalled();
  });
});

describe("handleStop (#1534)", () => {
  it("interrupts the selected session's own transport via Spin with the boot transport as fallback", async () => {
    const spinMod = await import("../spin.js");
    const interrupt = vi.spyOn(spinMod.spin, "interruptSession").mockResolvedValue(undefined);
    const ctx = { sessionKey: "1_A_01", transport: { sendInterrupt: vi.fn() }, reply: vi.fn().mockResolvedValue(undefined) } as any;

    await handleStop("/stop", ctx);

    expect(interrupt).toHaveBeenCalledOnce();
    expect(interrupt).toHaveBeenCalledWith("1_A_01", ctx.transport, "operator");
    expect(ctx.transport.sendInterrupt).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith("🛑 Ctrl+C sent.");
  });
});
