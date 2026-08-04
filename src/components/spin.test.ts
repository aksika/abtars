import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Spin } from "./spin.js";
import { setUserRegistryOverride, type UserRegistry, type UserEntry } from "./user-registry.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";

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

function mockTransport(): IKiroTransport {
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
  } as unknown as IKiroTransport;
}

describe("Spin — unified session router (#943)", () => {
  let spin: Spin;

  beforeEach(() => {
    spin = new Spin();
    const mockRuntime = {
      session: vi.fn().mockResolvedValue({
        sendPrompt: vi.fn().mockResolvedValue("agent response"),
        destroy: vi.fn(),
        get isReady() { return true; },
        get transport() { return mockTransport(); },
      }),
    };
    spin.setRuntime(mockRuntime as any);
    setUserRegistryOverride(makeRegistry([
      makeUser("aksika", "master", 111),
      makeUser("adrika", "user", 222),
      makeUser("visitor", "guest", 333),
    ]));
  });

  afterEach(() => {
    setUserRegistryOverride(null);
  });

  describe("registerMasterSession", () => {
    it("sets transport and delivery on the active session", () => {
      const transport = mockTransport();
      spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport });

      const session = spin.getActiveSession("aksika", "telegram");
      expect(session.transport).toBe(transport);
      expect(session.delivery).toBe("streaming");
      expect(session.idleTimeoutMs).toBe(Infinity);
      expect(session.status).toBe("ready");
    });
  });

  describe("resolveSession", () => {
    it("returns master session with transport when registered", async () => {
      const transport = mockTransport();
      spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport });

      const session = await spin.resolveSession("aksika", "telegram", 111);
      expect(session.transport).toBe(transport);
      expect(session.delivery).toBe("streaming");
    });

    it("creates transport for non-master user", async () => {
      const session = await spin.resolveSession("adrika", "telegram", 222);

      expect(session.status).toBe("ready");
      expect(session.delivery).toBe("simple");
      expect(session.transport).toBeDefined();
      expect(session.userId).toBe("adrika");
    });

    it("reuses existing session with transport", async () => {
      const s1 = await spin.resolveSession("adrika", "telegram", 222);
      const s2 = await spin.resolveSession("adrika", "telegram", 222);
      expect(s1).toBe(s2);
    });

    it("rejects paused session even with transport (#1347)", async () => {
      const transport = mockTransport();
      spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport });
      const session = spin.getActiveSession("aksika", "telegram");
      session.status = "paused";

      await expect(spin.resolveSession("aksika", "telegram", 111))
        .rejects.toThrow("Session is paused — use /session resume");
    });
  });

  describe("destroySession", () => {
    it("destroys non-master session transport", async () => {
      const session = await spin.resolveSession("adrika", "telegram", 222);

      spin.destroySession("adrika", session.id);
      expect(session.status).toBe("ended");
      expect(session.transport).toBeUndefined();
      expect(session.releaseTransport).toBeUndefined();
    });

    it("refuses to destroy master session", () => {
      const transport = mockTransport();
      spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport });

      spin.destroySession("aksika");
      const session = spin.getActiveSession("aksika", "telegram");
      expect(session.transport).toBe(transport);
    });

    it("records endedAt when a user ends a session", () => {
      const created = spin.createSession("adrika", "telegram", "C");
      expect(typeof created).not.toBe("string");
      const session = created as import("./spin-types.js").ManagedSession;

      const ended = spin.endSession("adrika", "telegram", session.shortIndex);
      expect(typeof ended).not.toBe("string");
      expect((ended as unknown as Record<string, unknown>)["endedAt"]).toEqual(expect.any(Number));
      expect((ended as import("./spin-types.js").ManagedSession).status).toBe("ended");
    });
  });

  describe("injectGreeting", () => {
    it("returns null for unknown user", async () => {
      const result = await spin.injectGreeting("nobody", "hello");
      expect(result).toBeNull();
    });

    it("returns null when no greeting adapter is set", async () => {
      spin.setGreetingAdapter(null as any);
      const result = await spin.injectGreeting("adrika", "Good morning!");
      expect(result).toBeNull();
      spin.setGreetingAdapter({ injectMessage: () => {} } as any);
    });

    it("injects synthetic message via the adapter so pipeline delivers response (#1106 regression)", async () => {
      const captured: any[] = [];
      spin.setGreetingAdapter({ injectMessage: (msg) => captured.push(msg) } as any);
      const result = await spin.injectGreeting("adrika", "[SYSTEM] scheduled check-in");
      expect(result).toBe("routed");
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        userId: "adrika",
        text: "[SYSTEM] scheduled check-in",
        isGroup: false,
        isVoice: false,
      });
    });
  });

  describe("session CRUD", () => {
    it("creates and lists sessions", () => {
      const result = spin.createSession("aksika", "telegram", "C");
      expect(typeof result).not.toBe("string");
      const sessions = spin.listSessions("aksika", "telegram");
      expect(sessions.sessions.length).toBe(2); // Main + Code
    });

    it("destroyAll cleans everything", async () => {
      const transport = mockTransport();
      spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport });
      await spin.resolveSession("adrika", "telegram", 222);
      // #1540: live occupancy and controls belong to the facade too — shutdown
      // must clear the supervisor along with the session registry.
      spin.executionSupervisor.admit("T", 777);

      spin.destroyAll();
      expect(spin.listAllSessions()).toHaveLength(0);
      expect(spin.executionSupervisor.runningCardIds()).toEqual([]);
    });

    it("createHollowSession creates a session with peer and no transport", () => {
      const result = spin.createHollowSession("aksika", "telegram", "W", "molty", "remote_W_01");
      expect(typeof result).not.toBe("string");
      const session = result as import("./spin-types.js").ManagedSession;
      expect(session.peer).toBe("molty");
      expect(session.remoteSessionId).toBe("remote_W_01");
      expect(session.transport).toBeUndefined();
      expect(session.busy).toBe(false);
      expect(session.messageCount).toBe(0);
      // Visible in list
      const all = spin.listAllSessions();
      expect(all.some(s => s.peer === "molty")).toBe(true);
    });
  });

  describe("greetSession (#968)", () => {
    it("fires inject for A session", () => {
      const session = spin.getActiveSession("aksika", "telegram");
      session.transport = mockTransport();
      const adapter = { injectMessage: vi.fn() };
      spin.greetSession(session, 111, "aksika", adapter);
      expect(adapter.injectMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("[SESSION START]"),
        userId: "aksika",
      }));
    });

    it("fires inject for C session", () => {
      const result = spin.createSession("aksika", "telegram", "C");
      expect(typeof result).not.toBe("string");
      const session = result as import("./spin-types.js").ManagedSession;
      session.transport = mockTransport();
      const adapter = { injectMessage: vi.fn() };
      spin.greetSession(session, 111, "aksika", adapter);
      expect(adapter.injectMessage).toHaveBeenCalled();
    });

    it("skips non-interactive types (O, T, W)", () => {
      const adapter = { injectMessage: vi.fn() };
      for (const type of ["O", "T", "W"] as const) {
        const result = spin.createSubSession("aksika", "telegram", type);
        if (typeof result === "string") continue;
        result.transport = mockTransport();
        spin.greetSession(result, 111, "aksika", adapter);
      }
      expect(adapter.injectMessage).not.toHaveBeenCalled();
    });

    it("skips if messageCount > 0", () => {
      const session = spin.getActiveSession("aksika", "telegram");
      session.transport = mockTransport();
      session.messageCount = 5;
      const adapter = { injectMessage: vi.fn() };
      spin.greetSession(session, 111, "aksika", adapter);
      expect(adapter.injectMessage).not.toHaveBeenCalled();
    });
  });

  describe("killSession (#1501)", () => {
    it("kills a background session by index from the owner's telegram scope", () => {
      const bg = spin.createSubSession("aksika", "background", "T");
      expect(typeof bg).not.toBe("string");
      const session = bg as import("./spin-types.js").ManagedSession;
      const idx = session.shortIndex;

      const result = spin.killSession("aksika", "telegram", idx);
      expect(typeof result).not.toBe("string");
      expect((result as import("./spin-types.js").ManagedSession).status).toBe("ended");
      expect((result as import("./spin-types.js").ManagedSession).transport).toBeUndefined();

      const all = spin.listAllSessions();
      expect(all.some(s => s.shortIndex === idx)).toBe(false);

      const bgSessions = all.filter(s => s.platform === "background" && s.userId === "aksika");
      expect(bgSessions.length).toBe(0);
    });

    it("still returns platform-scoped error for non-background miss", () => {
      const result = spin.killSession("aksika", "telegram", 999);
      expect(result).toContain("not found on telegram");
    });
  });

  describe("interruptSession (#1534)", () => {
    it("interrupts the session's own transport, not the fallback, and clears busy", async () => {
      const session = spin.getActiveSession("aksika", "tui");
      const sessionTransport = mockTransport();
      session.transport = sessionTransport;
      session.busy = true;
      const fallback = mockTransport();

      await spin.interruptSession(session.id, fallback, "operator");

      expect(sessionTransport.sendInterrupt).toHaveBeenCalledOnce();
      expect(sessionTransport.sendInterrupt).toHaveBeenCalledWith("operator");
      expect(fallback.sendInterrupt).not.toHaveBeenCalled();
      expect(session.busy).toBe(false);
    });

    it("uses the fallback transport for a transportless session and clears busy", async () => {
      const session = spin.getActiveSession("aksika", "tui");
      session.transport = undefined;
      session.busy = true;
      const fallback = mockTransport();

      await spin.interruptSession(session.id, fallback);

      expect(fallback.sendInterrupt).toHaveBeenCalledOnce();
      expect(fallback.sendInterrupt).toHaveBeenCalledWith("operator");
      expect(session.busy).toBe(false);
    });

    it("uses the fallback transport when the session is absent", async () => {
      const fallback = mockTransport();
      await spin.interruptSession("missing_session", fallback);
      expect(fallback.sendInterrupt).toHaveBeenCalledOnce();
    });

    it("does not clear busy when the interrupt rejects", async () => {
      const session = spin.getActiveSession("aksika", "tui");
      const sessionTransport = mockTransport();
      sessionTransport.sendInterrupt = vi.fn().mockRejectedValue(new Error("interrupt failed"));
      session.transport = sessionTransport;
      session.busy = true;

      await expect(spin.interruptSession(session.id, mockTransport())).rejects.toThrow("interrupt failed");
      expect(session.busy).toBe(true);
    });

    it("preserves the session, its transport, and its queue", async () => {
      const session = spin.getActiveSession("aksika", "tui");
      const sessionTransport = mockTransport();
      session.transport = sessionTransport;
      session.busy = true;
      session.queue.push({ msg: {}, adapter: {} } as never);

      await spin.interruptSession(session.id, mockTransport());

      expect(spin.getSessionById(session.id)).toBe(session);
      expect(session.transport).toBe(sessionTransport);
      expect(session.queue.length).toBe(1);
      expect(session.status).not.toBe("ended");
    });
  });
});
