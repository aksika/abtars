import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager, type ManagedSession } from "./session-manager.js";

describe("SessionManager", () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager(5);
  });

  it("creates initial main session on first access", () => {
    const id = mgr.getActiveSessionId("u1", "telegram");
    expect(id).toMatch(/^\d+_A_01$/);
  });

  it("createSession sets motherId from active session", () => {
    const mainId = mgr.getActiveSessionId("u1", "telegram");
    const result = mgr.createSession("u1", "telegram", "C") as ManagedSession;
    expect(result.motherId).toBe(mainId);
    expect(result.type).toBe("C");
  });

  it("createSubSession sets motherId from active session", () => {
    const mainId = mgr.getActiveSessionId("u1", "telegram");
    const result = mgr.createSubSession("u1", "telegram", "B") as ManagedSession;
    expect(result.motherId).toBe(mainId);
    expect(result.isTransport).toBe(false);
  });

  it("enforces max sessions", () => {
    mgr.getActiveSessionId("u1", "telegram"); // #1
    mgr.createSession("u1", "telegram", "C"); // #2
    mgr.createSession("u1", "telegram", "C"); // #3
    mgr.createSession("u1", "telegram", "C"); // #4
    mgr.createSession("u1", "telegram", "C"); // #5
    const result = mgr.createSession("u1", "telegram", "C");
    expect(typeof result).toBe("string");
    expect(result).toContain("Max sessions");
  });

  it("pauseSession sets paused flag", () => {
    mgr.getActiveSessionId("u1", "telegram");
    const result = mgr.pauseSession("u1", "telegram") as ManagedSession;
    expect(result.paused).toBe(true);
  });

  it("resumeSession clears paused flag", () => {
    mgr.getActiveSessionId("u1", "telegram");
    mgr.pauseSession("u1", "telegram");
    const result = mgr.resumeSession("u1", "telegram") as ManagedSession;
    expect(result.paused).toBe(false);
  });

  it("pauseSession errors if already paused", () => {
    mgr.getActiveSessionId("u1", "telegram");
    mgr.pauseSession("u1", "telegram");
    const result = mgr.pauseSession("u1", "telegram");
    expect(typeof result).toBe("string");
    expect(result).toContain("already paused");
  });

  it("resumeSession errors if not paused", () => {
    mgr.getActiveSessionId("u1", "telegram");
    const result = mgr.resumeSession("u1", "telegram");
    expect(typeof result).toBe("string");
    expect(result).toContain("not paused");
  });

  it("getSessionById finds session across platforms", () => {
    const id = mgr.getActiveSessionId("u1", "telegram");
    const found = mgr.getSessionById(id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(id);
  });

  it("switchSession changes active index", () => {
    mgr.getActiveSessionId("u1", "telegram");
    const s2 = mgr.createSession("u1", "telegram", "C") as ManagedSession;
    mgr.switchSession("u1", "telegram", 1); // back to main
    const active = mgr.getActiveSession("u1", "telegram");
    expect(active.shortIndex).toBe(1);
  });

  it("formatList shows pause marker and mother", () => {
    mgr.getActiveSessionId("u1", "telegram");
    mgr.createSession("u1", "telegram", "C");
    mgr.pauseSession("u1", "telegram", 2);
    const list = mgr.formatList("u1", "telegram");
    expect(list).toContain("⏸");
    expect(list).toContain("← #1");
  });

  it("endSession on last main creates replacement", () => {
    mgr.getActiveSessionId("u1", "telegram");
    mgr.endSession("u1", "telegram", 1);
    const { sessions } = mgr.listSessions("u1", "telegram");
    const mains = sessions.filter(s => s.type === "A");
    expect(mains.length).toBe(1);
    expect(mains[0]!.shortIndex).toBe(2);
  });
});
