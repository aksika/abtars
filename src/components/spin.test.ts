import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Spin } from "./spin.js";
import { SessionManager } from "./session-manager.js";
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

describe("Spin — interactive session management (#936 + #938)", () => {
  let spin: Spin;
  let sm: SessionManager;

  beforeEach(() => {
    spin = new Spin();
    sm = new SessionManager();
    const mockRuntime = {
      session: vi.fn().mockResolvedValue({
        sendPrompt: vi.fn().mockResolvedValue("agent response"),
        destroy: vi.fn(),
        get isReady() { return true; },
        get transport() { return mockTransport(); },
      }),
    };
    spin.setRuntime(mockRuntime as any);
    spin.setSessionManager(sm);
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
    it("sets transport and delivery on the active SessionManager session", () => {
      const transport = mockTransport();
      spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport });

      const session = sm.getActiveSession("aksika", "telegram");
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
      const session = sm.getActiveSession("aksika", "telegram");
      expect(session.transport).toBe(transport); // still there
    });
  });

  describe("injectGreeting", () => {
    it("returns null for unknown user", async () => {
      const result = await spin.injectGreeting("nobody", "hello");
      expect(result).toBeNull();
    });

    it("creates session and delivers greeting for known user", async () => {
      const result = await spin.injectGreeting("adrika", "Good morning!");
      expect(result).toBeDefined();
    });

    it("reuses existing session", async () => {
      await spin.resolveSession("adrika", "telegram", 222);
      const session = sm.getActiveSession("adrika", "telegram");
      const transportBefore = session.transport;

      await spin.injectGreeting("adrika", "Hello again!");
      expect(session.transport).toBe(transportBefore); // same transport
    });
  });
});
