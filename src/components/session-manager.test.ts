import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpHome = join(tmpdir(), `sm-test-init-${Date.now()}`);
mkdirSync(tmpHome, { recursive: true });

vi.mock("../paths.js", () => ({
  abtarsHome: () => tmpHome,
}));

vi.mock("./logger.js", () => ({
  logInfo: () => {},
  logWarn: () => {},
  logDebug: () => {},
  logTrace: () => {},
}));

const { SessionManager, parseSessionType, typeLabel } = await import("./session-manager.js");

describe("SessionManager", () => {
  let sm: SessionManager;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `sm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpHome, { recursive: true });
    sm = new SessionManager(5);
  });

  afterEach(() => {
    try { rmSync(tmpHome, { recursive: true }); } catch { /* */ }
  });

  describe("createSession", () => {
    it("creates session with type-stamped ID", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      expect(s.id).toMatch(/_A_\d+$/);
      expect(s.id.split("_")[1]).toBe("A");
      expect(s.isTransport).toBe(true);
      expect(s.status).not.toBe("ended");
      expect(s.status).not.toBe("paused");
    });

    it("increments shortIndex monotonically", () => {
      // First getOrCreateState creates index 1 (auto-main)
      const s1 = sm.createSession("user1", "telegram", "A") as any;
      const s2 = sm.createSession("user1", "telegram", "A") as any;
      expect(s2.shortIndex).toBe(s1.shortIndex + 1);
    });

    it("sets new session as active", () => {
      sm.createSession("user1", "telegram", "A");
      const s2 = sm.createSession("user1", "telegram", "A") as any;
      expect(sm.getActiveSessionId("user1", "telegram")).toBe(s2.id);
    });

    it("no motherId for user-created sessions", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      expect(s.motherId).toBeUndefined();
    });

    it("enforces max sessions limit", () => {
      for (let i = 0; i < 5; i++) sm.createSession("user1", "telegram", "A");
      const result = sm.createSession("user1", "telegram", "A");
      expect(typeof result).toBe("string");
      expect(result).toContain("Max sessions");
    });

    it("isolates users — different users have independent sessions", () => {
      const s1 = sm.createSession("user1", "telegram", "A") as any;
      const s2 = sm.createSession("user2", "telegram", "A") as any;
      expect(sm.getActiveSessionId("user1", "telegram")).toBe(s1.id);
      expect(sm.getActiveSessionId("user2", "telegram")).toBe(s2.id);
    });

    it("isolates platforms — same user different platforms are independent", () => {
      const s1 = sm.createSession("user1", "telegram", "A") as any;
      const s2 = sm.createSession("user1", "discord", "A") as any;
      expect(sm.getActiveSessionId("user1", "telegram")).toBe(s1.id);
      expect(sm.getActiveSessionId("user1", "discord")).toBe(s2.id);
    });
  });

  describe("createSubSession", () => {
    it("sets motherId from active session", () => {
      const parent = sm.createSession("user1", "telegram", "A") as any;
      const child = sm.createSubSession("user1", "telegram", "C") as any;
      expect(child.motherId).toBe(parent.id);
    });

    it("isTransport is false for sub-sessions", () => {
      sm.createSession("user1", "telegram", "A");
      const child = sm.createSubSession("user1", "telegram", "B") as any;
      expect(child.isTransport).toBe(false);
    });

    it("does not change active session", () => {
      const parent = sm.createSession("user1", "telegram", "A") as any;
      sm.createSubSession("user1", "telegram", "C");
      expect(sm.getActiveSessionId("user1", "telegram")).toBe(parent.id);
    });

    it("respects max sessions limit", () => {
      for (let i = 0; i < 5; i++) sm.createSession("user1", "telegram", "A");
      const result = sm.createSubSession("user1", "telegram", "T");
      expect(typeof result).toBe("string");
    });
  });

  describe("switchSession", () => {
    it("switches active to target index", () => {
      const s1 = sm.createSession("user1", "telegram", "A") as any;
      sm.createSession("user1", "telegram", "A");
      sm.switchSession("user1", "telegram", s1.shortIndex);
      expect(sm.getActiveSessionId("user1", "telegram")).toBe(s1.id);
    });

    it("returns error for non-existent index", () => {
      sm.createSession("user1", "telegram", "A");
      const result = sm.switchSession("user1", "telegram", 999);
      expect(typeof result).toBe("string");
      expect(result).toContain("not found");
    });

    it("cannot switch to ended session", () => {
      const s1 = sm.createSession("user1", "telegram", "A") as any;
      sm.createSession("user1", "telegram", "A");
      sm.endSession("user1", "telegram", s1.shortIndex);
      const result = sm.switchSession("user1", "telegram", s1.shortIndex);
      expect(typeof result).toBe("string");
    });

    it("cannot switch to sub-session (non-transport)", () => {
      sm.createSession("user1", "telegram", "A");
      const sub = sm.createSubSession("user1", "telegram", "C") as any;
      const result = sm.switchSession("user1", "telegram", sub.shortIndex);
      expect(typeof result).toBe("string");
    });
  });

  describe("endSession", () => {
    it("marks session ended", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      const ended = sm.endSession("user1", "telegram", s.shortIndex) as any;
      expect(ended.status).toBe("ended");
    });

    it("auto-creates replacement when ending last Main", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      sm.endSession("user1", "telegram", s.shortIndex);
      // Should have a new active Main
      const active = sm.getActiveSession("user1", "telegram");
      expect(active.id.split("_")[1]).toBe("A");
      expect(active.status).not.toBe("ended");
      expect(active.id).not.toBe(s.id);
    });

    it("switches to another Main when ending active", () => {
      // getOrCreateState auto-creates Main #1, createSession creates #2, #3
      sm.createSession("user1", "telegram", "A");
      const s3 = sm.createSession("user1", "telegram", "A") as any;
      sm.endSession("user1", "telegram", s3.shortIndex);
      // Should fall back to any alive Main (not s3)
      const activeId = sm.getActiveSessionId("user1", "telegram");
      expect(activeId).not.toBe(s3.id);
    });

    it("ended sessions don't appear in list", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      sm.endSession("user1", "telegram", s.shortIndex);
      const { sessions } = sm.listSessions("user1", "telegram");
      expect(sessions.find(x => x.id === s.id)).toBeUndefined();
    });
  });

  describe("killSession", () => {
    it("marks session ended", () => {
      sm.createSession("user1", "telegram", "A");
      const s2 = sm.createSession("user1", "telegram", "A") as any;
      const killed = sm.killSession("user1", "telegram", s2.shortIndex) as any;
      expect(killed.status).toBe("ended");
    });

    it("auto-creates replacement when killing last Main", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      sm.killSession("user1", "telegram", s.shortIndex);
      const active = sm.getActiveSession("user1", "telegram");
      expect(active.id.split("_")[1]).toBe("A");
      expect(active.id).not.toBe(s.id);
    });
  });

  describe("pauseSession / resumeSession", () => {
    it("toggles paused flag", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      sm.pauseSession("user1", "telegram", s.shortIndex);
      expect(sm.getActiveSession("user1", "telegram").status).toBe("paused");
      sm.resumeSession("user1", "telegram", s.shortIndex);
      expect(sm.getActiveSession("user1", "telegram").status).toBe("ready");
    });

    it("pause returns error if already paused", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      sm.pauseSession("user1", "telegram", s.shortIndex);
      const result = sm.pauseSession("user1", "telegram", s.shortIndex);
      expect(typeof result).toBe("string");
      expect(result).toContain("already paused");
    });

    it("resume returns error if not paused", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      const result = sm.resumeSession("user1", "telegram", s.shortIndex);
      expect(typeof result).toBe("string");
      expect(result).toContain("not paused");
    });
  });

  describe("expireAutoSessions", () => {
    it("expires old sub-sessions", () => {
      sm.createSession("user1", "telegram", "A");
      const sub = sm.createSubSession("user1", "telegram", "C") as any;
      // Backdate
      sub.lastActiveAt = Date.now() - 100_000;
      const expired = sm.expireAutoSessions(50_000);
      expect(expired).toHaveLength(1);
      expect(expired[0]!.id).toBe(sub.id);
      expect(sub.status).toBe("ended");
    });

    it("does not expire transport sessions", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      s.createdAt = Date.now() - 100_000;
      const expired = sm.expireAutoSessions(50_000);
      expect(expired).toHaveLength(0);
    });

    it("does not expire recent sub-sessions", () => {
      sm.createSession("user1", "telegram", "A");
      sm.createSubSession("user1", "telegram", "C");
      const expired = sm.expireAutoSessions(50_000);
      expect(expired).toHaveLength(0);
    });
  });

  describe("getSessionById", () => {
    it("finds session across platforms", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      expect(sm.getSessionById(s.id)?.id).toBe(s.id);
    });

    it("returns undefined for unknown ID", () => {
      expect(sm.getSessionById("nonexistent")).toBeUndefined();
    });
  });

  describe("clearPlatform / clearAll", () => {
    it("clearPlatform removes one user+platform", () => {
      sm.createSession("user1", "telegram", "A");
      sm.createSession("user1", "discord", "A");
      sm.clearPlatform("user1", "telegram");
      // telegram gone, discord still there
      const { sessions } = sm.listSessions("user1", "discord");
      expect(sessions.length).toBeGreaterThan(0);
    });

    it("clearAll removes everything", () => {
      sm.createSession("user1", "telegram", "A");
      sm.createSession("user2", "discord", "A");
      sm.clearAll();
      // Fresh state — getActiveSessionId creates new
      const id = sm.getActiveSessionId("user1", "telegram");
      expect(id).toMatch(/_A_/);
    });
  });

  describe("formatList", () => {
    it("shows active marker", () => {
      sm.createSession("user1", "telegram", "A");
      const output = sm.formatList("user1", "telegram");
      expect(output).toContain("*");
      expect(output).toContain("Main");
    });

    it("shows paused marker", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      sm.pauseSession("user1", "telegram", s.shortIndex);
      const output = sm.formatList("user1", "telegram");
      expect(output).toContain("⏸");
    });

    it("shows motherId lineage", () => {
      sm.createSession("user1", "telegram", "A");
      sm.createSubSession("user1", "telegram", "C");
      const output = sm.formatList("user1", "telegram");
      expect(output).toContain("←");
    });
  });

  describe("auto-main on first access", () => {
    it("getActiveSessionId creates Main session on first call", () => {
      const id = sm.getActiveSessionId("newuser", "telegram");
      expect(id).toMatch(/_A_01$/);
    });
  });
});

describe("parseSessionType", () => {
  it("parses known types", () => {
    expect(parseSessionType("browse")).toBe("B");
    expect(parseSessionType("code")).toBe("C");
    expect(parseSessionType("task")).toBe("T");
  });

  it("returns null for unknown", () => {
    expect(parseSessionType("main")).toBeNull();
    expect(parseSessionType("xyz")).toBeNull();
  });
});

describe("typeLabel", () => {
  it("returns human labels", () => {
    expect(typeLabel("A")).toBe("Main");
    expect(typeLabel("S")).toBe("System");
    expect(typeLabel("P")).toBe("Peer");
  });
});
