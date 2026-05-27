import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager } from "./session-manager.js";

describe("SessionManager", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager(5);
  });

  describe("createSession", () => {
    it("creates session with unique ID", () => {
      const s = sm.createSession("user1", "telegram", "A");
      expect(typeof s).not.toBe("string");
      expect((s as any).id).toContain("_A_");
    });

    it("no motherId for user-created sessions", () => {
      sm.createSession("user1", "telegram", "A");
      const s2 = sm.createSession("user1", "telegram", "A");
      expect((s2 as any).motherId).toBeUndefined();
    });

    it("enforces max sessions limit", () => {
      for (let i = 0; i < 5; i++) sm.createSession("user1", "telegram", "A");
      const result = sm.createSession("user1", "telegram", "A");
      expect(typeof result).toBe("string"); // error message
      expect(result).toContain("Max sessions");
    });
  });

  describe("createSubSession", () => {
    it("sets motherId from active session", () => {
      const parent = sm.createSession("user1", "telegram", "A") as any;
      const child = sm.createSubSession("user1", "telegram", "C") as any;
      expect(child.motherId).toBe(parent.id);
    });
  });

  describe("switch", () => {
    it("getActiveSessionId returns correct ID after switch", () => {
      const s1 = sm.createSession("user1", "telegram", "A") as any;
      const s2 = sm.createSession("user1", "telegram", "A") as any;
      expect(sm.getActiveSessionId("user1", "telegram")).toBe(s2.id);
      // Switch back to s1
      sm.switchSession("user1", "telegram", s1.shortIndex);
      expect(sm.getActiveSessionId("user1", "telegram")).toBe(s1.id);
    });

    it("switch does NOT destroy other sessions", () => {
      const s1 = sm.createSession("user1", "telegram", "A") as any;
      sm.createSession("user1", "telegram", "A");
      sm.switchSession("user1", "telegram", s1.shortIndex);
      // Both sessions still exist
      const active = sm.getActiveSession("user1", "telegram");
      expect(active.id).toBe(s1.id);
    });
  });

  describe("endSession", () => {
    it("marks session ended and switches to another", () => {
      sm.createSession("user1", "telegram", "A");
      const s2 = sm.createSession("user1", "telegram", "A") as any;
      const ended = sm.endSession("user1", "telegram", s2.shortIndex);
      expect((ended as any).ended).toBe(true);
      // Active should be s1 now
      expect(sm.getActiveSessionId("user1", "telegram")).not.toBe(s2.id);
    });
  });

  describe("pauseSession", () => {
    it("toggles paused flag", () => {
      const s = sm.createSession("user1", "telegram", "A") as any;
      sm.pauseSession("user1", "telegram", s.shortIndex);
      const paused = sm.getActiveSession("user1", "telegram");
      expect(paused.paused).toBe(true);
    });
  });
});
