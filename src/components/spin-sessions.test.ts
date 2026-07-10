import { describe, it, expect, beforeEach } from "vitest";
import type { ManagedSession } from "./spin-types.js";
import * as Sessions from "./spin-sessions.js";

function makeTestSessions(): Map<string, ManagedSession> {
  const sessions = new Map<string, ManagedSession>();
  let next = 0;

  // Telegram Main
  const tg = Sessions.allocateSession(sessions, next, "A", "aksika", "telegram", 100);
  next = tg.nextIndex;
  tg.session.active = true;

  // TUI Main (same user, different platform)
  const tui = Sessions.allocateSession(sessions, next, "A", "aksika", "tui", 0);
  next = tui.nextIndex;
  tui.session.active = true;  // both active — simulates parallel attachment

  // Background
  const bg = Sessions.allocateSession(sessions, next, "S", "aksika", "background", 0);
  next = bg.nextIndex;

  // Another user's session on telegram
  const other = Sessions.allocateSession(sessions, next, "A", "bob", "telegram", 200);
  next = other.nextIndex;
  other.session.active = true;

  // Ended session on telegram
  const ended = Sessions.allocateSession(sessions, next, "A", "aksika", "telegram", 100);
  next = ended.nextIndex;
  ended.session.status = "ended";
  ended.session.active = false;

  return sessions;
}

function lifecycleSnapshot(sessions: Map<string, ManagedSession>): Array<{ id: string; platform: string; active: boolean; status: string }> {
  return [...sessions.values()].map(s => ({ id: s.id, platform: s.platform, active: s.active, status: s.status }));
}

function findIndex(sessions: Map<string, ManagedSession>, platform: string, type = "A"): number | undefined {
  return [...sessions.values()].find(s => s.platform === platform && s.id.includes(`_${type}_`) && s.status !== "ended")?.shortIndex;
}

describe("spin-sessions — platform ownership (#1330)", () => {
  describe("switchSession", () => {
    it("succeeds for same-platform target", () => {
      const sessions = makeTestSessions();
      const tgIdx = findIndex(sessions, "telegram")!;
      const result = Sessions.switchSession(sessions, "aksika", "telegram", tgIdx);
      expect(typeof result).not.toBe("string");
      expect((result as ManagedSession).platform).toBe("telegram");
    });

    it("rejects foreign-platform target", () => {
      const sessions = makeTestSessions();
      const tuiIdx = findIndex(sessions, "tui")!;
      // Try to switch to a TUI session from telegram platform
      const result = Sessions.switchSession(sessions, "aksika", "telegram", tuiIdx);
      expect(typeof result).toBe("string");
      expect(result).toMatch(/not found on telegram/i);
    });

    it("rejects foreign-user target", () => {
      const sessions = makeTestSessions();
      const bobSession = [...sessions.values()].find(s => s.userId === "bob")!;
      const result = Sessions.switchSession(sessions, "aksika", "telegram", bobSession.shortIndex);
      expect(typeof result).toBe("string");
    });

    it("rejects ended target", () => {
      const sessions = makeTestSessions();
      const ended = [...sessions.values()].find(s => s.status === "ended")!;
      const result = Sessions.switchSession(sessions, "aksika", "telegram", ended.shortIndex);
      expect(typeof result).toBe("string");
    });

    it("is idempotent when switching to already-active target", () => {
      const sessions = makeTestSessions();
      const tgIdx = findIndex(sessions, "telegram")!;
      const before = lifecycleSnapshot(sessions);
      const result = Sessions.switchSession(sessions, "aksika", "telegram", tgIdx);
      expect(typeof result).not.toBe("string");
      const after = lifecycleSnapshot(sessions);
      expect(after).toEqual(before);
    });

    it("rejected switch performs no mutation", () => {
      const sessions = makeTestSessions();
      const tuiIdx = findIndex(sessions, "tui")!;
      const before = lifecycleSnapshot(sessions);
      const result = Sessions.switchSession(sessions, "aksika", "telegram", tuiIdx);
      expect(typeof result).toBe("string");
      const after = lifecycleSnapshot(sessions);
      expect(after).toEqual(before);
    });

    it("preserves foreign-platform active session after a valid local switch", () => {
      const sessions = makeTestSessions();
      // We have both telegram active and tui active.
      // Create another telegram session, then switch to it.
      let next = [...sessions.values()].length;
      const s2 = Sessions.allocateSession(sessions, next, "A", "aksika", "telegram", 100);
      s2.session.active = false;
      next = s2.nextIndex;

      const tgIdx1 = findIndex(sessions, "telegram")!;
      Sessions.switchSession(sessions, "aksika", "telegram", tgIdx1);

      // TUI should still have its own active session
      const tuiActive = Sessions.getActiveSession(sessions, "aksika", "tui");
      expect(tuiActive).toBeDefined();
      expect(tuiActive!.platform).toBe("tui");
      expect(tuiActive!.active).toBe(true);
    });
  });

  describe("endSession", () => {
    it("succeeds for same-platform target by index", () => {
      const sessions = makeTestSessions();
      const tgIdx = findIndex(sessions, "telegram")!;
      const result = Sessions.endSession(sessions, 99, "aksika", "telegram", tgIdx);
      expect(typeof result).not.toBe("string");
    });

    it("rejects foreign-platform target", () => {
      const sessions = makeTestSessions();
      const tuiIdx = findIndex(sessions, "tui")!;
      const result = Sessions.endSession(sessions, 99, "aksika", "telegram", tuiIdx);
      expect(typeof result).toBe("string");
      expect(result).toMatch(/not found on telegram/i);
    });

    it("rejected end performs no mutation", () => {
      const sessions = makeTestSessions();
      const tuiIdx = findIndex(sessions, "tui")!;
      const before = lifecycleSnapshot(sessions);
      Sessions.endSession(sessions, 99, "aksika", "telegram", tuiIdx);
      const after = lifecycleSnapshot(sessions);
      expect(after).toEqual(before);
    });
  });

  describe("killSession", () => {
    it("succeeds for same-platform target", () => {
      const sessions = makeTestSessions();
      const tgIdx = findIndex(sessions, "telegram")!;
      const result = Sessions.killSession(sessions, 99, "aksika", "telegram", tgIdx);
      expect(typeof result).not.toBe("string");
    });

    it("rejects foreign-platform target", () => {
      const sessions = makeTestSessions();
      const tuiIdx = findIndex(sessions, "tui")!;
      const result = Sessions.killSession(sessions, 99, "aksika", "telegram", tuiIdx);
      expect(typeof result).toBe("string");
      expect(result).toMatch(/not found on telegram/i);
    });

    it("rejected kill performs no mutation", () => {
      const sessions = makeTestSessions();
      const tuiIdx = findIndex(sessions, "tui")!;
      const before = lifecycleSnapshot(sessions);
      Sessions.killSession(sessions, 99, "aksika", "telegram", tuiIdx);
      const after = lifecycleSnapshot(sessions);
      expect(after).toEqual(before);
    });
  });

  describe("pauseSession", () => {
    it("succeeds for same-platform target", () => {
      const sessions = makeTestSessions();
      const tgIdx = findIndex(sessions, "telegram")!;
      const result = Sessions.pauseSession(sessions, "aksika", "telegram", tgIdx);
      expect(typeof result).not.toBe("string");
    });

    it("rejects foreign-platform target", () => {
      const sessions = makeTestSessions();
      const tuiIdx = findIndex(sessions, "tui")!;
      const result = Sessions.pauseSession(sessions, "aksika", "telegram", tuiIdx);
      expect(typeof result).toBe("string");
      expect(result).toMatch(/not found on telegram/i);
    });

    it("rejected pause performs no mutation", () => {
      const sessions = makeTestSessions();
      const tuiIdx = findIndex(sessions, "tui")!;
      const before = lifecycleSnapshot(sessions);
      Sessions.pauseSession(sessions, "aksika", "telegram", tuiIdx);
      const after = lifecycleSnapshot(sessions);
      expect(after).toEqual(before);
    });
  });

  describe("resumeSession", () => {
    it("succeeds for same-platform paused target", () => {
      const sessions = makeTestSessions();
      const tgIdx = findIndex(sessions, "telegram")!;
      Sessions.pauseSession(sessions, "aksika", "telegram", tgIdx);
      const result = Sessions.resumeSession(sessions, "aksika", "telegram", tgIdx);
      expect(typeof result).not.toBe("string");
    });

    it("rejects foreign-platform target", () => {
      const sessions = makeTestSessions();
      const tuiIdx = findIndex(sessions, "tui")!;
      // Pause the tui session first
      Sessions.pauseSession(sessions, "aksika", "tui", tuiIdx);
      const result = Sessions.resumeSession(sessions, "aksika", "telegram", tuiIdx);
      expect(typeof result).toBe("string");
      expect(result).toMatch(/not found on telegram/i);
    });

    it("rejected resume performs no mutation", () => {
      const sessions = makeTestSessions();
      const tuiIdx = findIndex(sessions, "tui")!;
      Sessions.pauseSession(sessions, "aksika", "tui", tuiIdx);
      const before = lifecycleSnapshot(sessions);
      Sessions.resumeSession(sessions, "aksika", "telegram", tuiIdx);
      const after = lifecycleSnapshot(sessions);
      expect(after).toEqual(before);
    });
  });

  describe("Telegram and TUI retain independent active sessions", () => {
    it("both platforms have independent active sessions", () => {
      const sessions = makeTestSessions();
      const tgActive = Sessions.getActiveSession(sessions, "aksika", "telegram");
      const tuiActive = Sessions.getActiveSession(sessions, "aksika", "tui");
      expect(tgActive).toBeDefined();
      expect(tgActive!.platform).toBe("telegram");
      expect(tuiActive).toBeDefined();
      expect(tuiActive!.platform).toBe("tui");
      expect(tgActive!.id).not.toBe(tuiActive!.id);
    });
  });
});
