import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Spin, type ManagedUserSession } from "./spin.js";
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

describe("Spin — interactive session management (#936)", () => {
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
    it("registers master with streaming delivery and infinite idle", () => {
      const transport = mockTransport();
      spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport });

      const session = spin.userSessions.get("aksika");
      expect(session).toBeDefined();
      expect(session!.delivery).toBe("streaming");
      expect(session!.idleTimeoutMs).toBe(Infinity);
      expect(session!.state).toBe("ready");
      expect(session!.transport).toBe(transport);
    });
  });

  describe("resolveSession", () => {
    it("returns existing master session without creating new one", async () => {
      const transport = mockTransport();
      spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport });

      const session = await spin.resolveSession("aksika", "telegram", 111);
      expect(session.transport).toBe(transport);
      expect(session.delivery).toBe("streaming");
    });

    it("creates new session for non-master user", async () => {
      const session = await spin.resolveSession("adrika", "telegram", 222);

      expect(session.state).toBe("ready");
      expect(session.delivery).toBe("simple");
      expect(session.userId).toBe("adrika");
      expect(spin.userSessions.has("adrika")).toBe(true);
    });

    it("reuses existing non-master session", async () => {
      const session1 = await spin.resolveSession("adrika", "telegram", 222);
      const session2 = await spin.resolveSession("adrika", "telegram", 222);

      expect(session1).toBe(session2);
    });

    it("throws when capacity reached", async () => {
      // Create 3 non-master sessions (MAX_USER_SESSIONS default)
      await spin.resolveSession("adrika", "telegram", 222);

      // Override registry with more users
      setUserRegistryOverride(makeRegistry([
        makeUser("aksika", "master", 111),
        makeUser("adrika", "user", 222),
        makeUser("user2", "user", 444),
        makeUser("user3", "user", 555),
        makeUser("user4", "user", 666),
      ]));

      await spin.resolveSession("user2", "telegram", 444);
      await spin.resolveSession("user3", "telegram", 555);

      await expect(spin.resolveSession("user4", "telegram", 666))
        .rejects.toThrow(/Session limit reached/);
    });

    it("recreates session after dead state", async () => {
      const session1 = await spin.resolveSession("adrika", "telegram", 222);
      spin.destroySession("adrika");

      const session2 = await spin.resolveSession("adrika", "telegram", 222);
      expect(session2).not.toBe(session1);
      expect(session2.state).toBe("ready");
    });
  });

  describe("destroySession", () => {
    it("destroys non-master session", async () => {
      await spin.resolveSession("adrika", "telegram", 222);
      expect(spin.userSessions.has("adrika")).toBe(true);

      spin.destroySession("adrika");
      expect(spin.userSessions.has("adrika")).toBe(false);
    });

    it("refuses to destroy master session", () => {
      const transport = mockTransport();
      spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport });

      spin.destroySession("aksika");
      expect(spin.userSessions.has("aksika")).toBe(true); // still there
    });

    it("no-op for unknown user", () => {
      expect(() => spin.destroySession("nobody")).not.toThrow();
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
      expect(spin.userSessions.has("adrika")).toBe(true);
    });

    it("reuses existing session for greeting", async () => {
      await spin.resolveSession("adrika", "telegram", 222);
      const session = spin.userSessions.get("adrika");

      await spin.injectGreeting("adrika", "Hello again!");

      // Same session object
      expect(spin.userSessions.get("adrika")).toBe(session);
    });
  });
});
