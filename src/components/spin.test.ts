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
  });

  describe("destroySession", () => {
    it("destroys non-master session transport", async () => {
      const session = await spin.resolveSession("adrika", "telegram", 222);
      const transport = session.transport!;

      spin.destroySession("adrika", session.id);
      expect(transport.destroy).toHaveBeenCalled();
      expect(session.status).toBe("ended");
      expect(session.transport).toBeUndefined();
    });

    it("refuses to destroy master session", () => {
      const transport = mockTransport();
      spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport });

      spin.destroySession("aksika");
      const session = spin.getActiveSession("aksika", "telegram");
      expect(session.transport).toBe(transport);
    });
  });

  describe("inject", () => {
    it("returns null for unknown user", async () => {
      const result = await spin.inject("nobody", "hello");
      expect(result).toBeNull();
    });

    it("creates session and delivers greeting for known user", async () => {
      const result = await spin.inject("adrika", "Good morning!");
      expect(result).toBeDefined();
    });

    it("reuses existing session", async () => {
      await spin.resolveSession("adrika", "telegram", 222);
      const session = spin.getActiveSession("adrika", "telegram");
      const transportBefore = session.transport;

      await spin.inject("adrika", "Hello again!");
      expect(session.transport).toBe(transportBefore);
    });

    it("returns null when deliver=false", async () => {
      const result = await spin.inject("adrika", "system msg", { deliver: false });
      expect(result).toBeNull();
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

      spin.destroyAll();
      expect(spin.listAllSessions()).toHaveLength(0);
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
});
