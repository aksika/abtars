import { describe, it, expect, beforeEach } from "vitest";
import type { ManagedSession, SessionType } from "./spin-types.js";
import { sessionType } from "./spin-types.js";
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

  describe("endSession — local active/Main reconciliation (#1331)", () => {
  function snapshot(sessions: Map<string, ManagedSession>) {
    return [...sessions.values()].sort((a, b) => a.shortIndex - b.shortIndex).map(s => ({
      id: s.id, userId: s.userId, platform: s.platform,
      type: sessionType(s), active: s.active, status: s.status,
    }));
  }

  function activeIds(sessions: Map<string, ManagedSession>, userId: string, platform: string): string[] {
    return [...sessions.values()].filter(s => s.userId === userId && s.platform === platform && s.status !== "ended" && s.active).map(s => s.id);
  }

  function mainIds(sessions: Map<string, ManagedSession>, userId: string, platform: string): string[] {
    return [...sessions.values()].filter(s => s.userId === userId && s.platform === platform && s.status !== "ended" && sessionType(s) === "A").map(s => s.id);
  }

  /** Build a minimal set of sessions for one test case. Returns {sessions, nextIndex}. */
  function buildSessions(...specs: Array<{ userId: string; platform: string; type: SessionType; active?: boolean; ended?: boolean }>): { sessions: Map<string, ManagedSession>; nextIndex: number } {
    const sessions = new Map<string, ManagedSession>();
    let next = 0;
    for (const spec of specs) {
      const r = Sessions.allocateSession(sessions, next, spec.type, spec.userId, spec.platform, 100);
      next = r.nextIndex;
      r.session.active = spec.active ?? false;
      if (spec.ended) { r.session.status = "ended"; r.session.active = false; }
    }
    return { sessions, nextIndex: next };
  }

  // ── Active Code ended, local Main exists ──
  it("active Code end activates local Main", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "C", active: true },
    );
    const codeSessions = [...sessions.values()].filter(s => sessionType(s) === "C");
    expect(codeSessions).toHaveLength(1);
    const codeIdx = codeSessions[0].shortIndex;

    const result = Sessions.endSession(sessions, nextIndex, "aksika", "telegram", codeIdx);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    // Code ended
    const code = sessions.get(result.ended.id)!;
    expect(code.status).toBe("ended");
    expect(code.active).toBe(false);

    // Exactly one active session on telegram — the Main
    const active = activeIds(sessions, "aksika", "telegram");
    expect(active).toHaveLength(1);
    const mains = mainIds(sessions, "aksika", "telegram");
    expect(mains).toContain(active[0]);
  });

  // ── Inactive Code ended ──
  it("inactive Code end preserves active Main", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "C", active: false },
    );
    const codeSessions = [...sessions.values()].filter(s => sessionType(s) === "C");
    const codeIdx = codeSessions[0].shortIndex;

    const beforeActive = activeIds(sessions, "aksika", "telegram");
    expect(beforeActive).toHaveLength(1);

    const result = Sessions.endSession(sessions, nextIndex, "aksika", "telegram", codeIdx);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    const afterActive = activeIds(sessions, "aksika", "telegram");
    expect(afterActive).toEqual(beforeActive);
  });

  // ── Active Main ended, another Main exists ──
  it("active Main end activates remaining Main", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );
    const endTarget = [...sessions.values()].find(s => s.active)!;
    const main2 = [...sessions.values()].find(s => !s.active && sessionType(s) === "A")!;

    const result = Sessions.endSession(sessions, nextIndex, "aksika", "telegram", endTarget.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(endTarget.status).toBe("ended");
    expect(main2.active).toBe(true);
    const active = activeIds(sessions, "aksika", "telegram");
    expect(active).toHaveLength(1);
    expect(active[0]).toBe(main2.id);
  });

  // ── Inactive Main ended, another Main exists ──
  it("inactive Main end preserves active Main", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );
    const inactiveMain = [...sessions.values()].find(s => !s.active && sessionType(s) === "A")!;
    const activeMain = [...sessions.values()].find(s => s.active && sessionType(s) === "A")!;

    const beforeActive = activeIds(sessions, "aksika", "telegram");
    const result = Sessions.endSession(sessions, nextIndex, "aksika", "telegram", inactiveMain.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(inactiveMain.status).toBe("ended");
    expect(activeMain.active).toBe(true);
    const afterActive = activeIds(sessions, "aksika", "telegram");
    expect(afterActive).toEqual(beforeActive);
  });

  // ── Last active Main ended ──
  it("last active Main end creates active replacement", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
    );
    const main = [...sessions.values()][0];

    const result = Sessions.endSession(sessions, nextIndex, "aksika", "telegram", main.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(main.status).toBe("ended");

    // Replacement created
    const live = [...sessions.values()].filter(s => s.userId === "aksika" && s.platform === "telegram" && s.status !== "ended");
    expect(live).toHaveLength(1);
    expect(live[0].id).not.toBe(main.id);
    expect(sessionType(live[0])).toBe("A");
    expect(live[0].active).toBe(true);
  });

  // ── Last inactive Main ended, Code is active ──
  it("last inactive Main end while Code active creates inactive replacement", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: false },
      { userId: "aksika", platform: "telegram", type: "C", active: true },
    );
    const main = [...sessions.values()].find(s => sessionType(s) === "A")!;
    const code = [...sessions.values()].find(s => sessionType(s) === "C")!;

    const result = Sessions.endSession(sessions, nextIndex, "aksika", "telegram", main.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(main.status).toBe("ended");

    // Code unchanged, replacement Main exists and is inactive
    expect(code.status).toBe("ready");
    expect(code.active).toBe(true);

    const liveMains = mainIds(sessions, "aksika", "telegram");
    const replacement = liveMains.find(id => id !== code.id);
    expect(replacement).toBeDefined();
    const replacementSession = sessions.get(replacement!)!;
    expect(replacementSession.active).toBe(false);

    // Exactly one active — the Code session
    const active = activeIds(sessions, "aksika", "telegram");
    expect(active).toHaveLength(1);
    expect(active[0]).toBe(code.id);
  });

  // ── Last inactive Main ended, no active ──
  it("last inactive Main end with no local active creates active replacement", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );
    const main = [...sessions.values()][0];

    const result = Sessions.endSession(sessions, nextIndex, "aksika", "telegram", main.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(main.status).toBe("ended");

    const live = [...sessions.values()].filter(s => s.userId === "aksika" && s.platform === "telegram" && s.status !== "ended");
    expect(live).toHaveLength(1);
    expect(live[0].active).toBe(true);
  });

  // ── Foreign namespace unchanged ──
  it("does not affect foreign platforms or users", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "C", active: false },
      { userId: "aksika", platform: "tui", type: "A", active: true },
      { userId: "bob", platform: "telegram", type: "A", active: true },
    );
    const beforeForeign = snapshot(sessions).filter(s => s.userId !== "aksika" || s.platform !== "telegram");

    const code = [...sessions.values()].find(s => sessionType(s) === "C")!;
    Sessions.endSession(sessions, nextIndex, "aksika", "telegram", code.shortIndex);

    const afterForeign = snapshot(sessions).filter(s => s.userId !== "aksika" || s.platform !== "telegram");
    expect(afterForeign).toEqual(beforeForeign);
  });

  // ── nextIndex only changes with replacement allocation ──
  it("nextIndex increments only when replacement Main is created", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );

    // End inactive Main (no replacement needed — another Main exists)
    const inactiveMain = [...sessions.values()].find(s => !s.active && sessionType(s) === "A")!;
    const r1 = Sessions.endSession(sessions, nextIndex, "aksika", "telegram", inactiveMain.shortIndex);
    expect(typeof r1).not.toBe("string");
    if (typeof r1 === "string") return;
    expect(r1.nextIndex).toBe(nextIndex);

    // End the last active Main (replacement created)
    const activeMain = [...sessions.values()].find(s => sessionType(s) === "A" && s.status !== "ended")!;
    const r2 = Sessions.endSession(sessions, r1.nextIndex, "aksika", "telegram", activeMain.shortIndex);
    expect(typeof r2).not.toBe("string");
    if (typeof r2 === "string") return;
    expect(r2.nextIndex).toBeGreaterThan(r1.nextIndex);
  });

  // ── Ended log exists exactly once ──
  it("adds exactly one 'ended' log entry", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
    );
    const main = [...sessions.values()][0];
    expect(main.log.filter(l => l.includes("ended"))).toHaveLength(0);

    Sessions.endSession(sessions, nextIndex, "aksika", "telegram", main.shortIndex);
    expect(main.log.filter(l => l.includes("ended"))).toHaveLength(1);
  });

  describe("killSession — platform reconciliation (#1346)", () => {
  // Scenario references mimic endSession (#1331) — identical expected outcomes.

  // ── Kill active Code, Main exists but inactive → Main activates ──
  it("killed active Code activates local Main", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: false },
      { userId: "aksika", platform: "telegram", type: "C", active: true },
    );
    const code = [...sessions.values()].find(s => sessionType(s) === "C")!;
    const result = Sessions.killSession(sessions, nextIndex, "aksika", "telegram", code.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(result.killed.id).toBe(code.id);
    expect(code.status).toBe("ended");
    expect(code.active).toBe(false);
    const main = [...sessions.values()].find(s => sessionType(s) === "A" && s.status !== "ended")!;
    expect(main.active).toBe(true);
  });

  // ── Kill inactive Code, Main is active → Main stays active ──
  it("inactive Code kill preserves active Main", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "C", active: false },
    );
    const code = [...sessions.values()].find(s => sessionType(s) === "C")!;
    Sessions.killSession(sessions, nextIndex, "aksika", "telegram", code.shortIndex);

    const main = [...sessions.values()].find(s => sessionType(s) === "A")!;
    expect(main.active).toBe(true);
    expect(main.status).not.toBe("ended");
  });

  // ── Kill active Main with spare → other Main activates ──
  it("active Main kill activates remaining Main", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );
    const activeMain = [...sessions.values()].find(s => s.active)!
    const result = Sessions.killSession(sessions, nextIndex, "aksika", "telegram", activeMain.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(result.killed.active).toBe(false);
    const remaining = [...sessions.values()].find(s => sessionType(s) === "A" && s.status !== "ended")!;
    expect(remaining.active).toBe(true);
    expect(remaining.id).not.toBe(activeMain.id);
  });

  // ── Kill inactive Main, active exists → no change ──
  it("inactive Main kill preserves active Main", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );
    const inactive = [...sessions.values()].find(s => !s.active)!;
    Sessions.killSession(sessions, nextIndex, "aksika", "telegram", inactive.shortIndex);

    const active = [...sessions.values()].find(s => s.active)!;
    expect(active.status).not.toBe("ended");
    expect(active.id).not.toBe(inactive.id);
  });

  // ── Kill last Main → replacement created (active) ──
  it("last active Main kill creates active replacement", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
    );
    const main = [...sessions.values()][0];
    const result = Sessions.killSession(sessions, nextIndex, "aksika", "telegram", main.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(main.status).toBe("ended");
    const live = [...sessions.values()].filter(s => s.userId === "aksika" && s.platform === "telegram" && s.status !== "ended");
    expect(live).toHaveLength(1);
    expect(live[0].active).toBe(true);
    expect(live[0].shortIndex).toBeGreaterThan(main.shortIndex);
  });

  // ── Kill last inactive Main, no active → active replacement ──
  it("last inactive Main kill with no local active creates active replacement", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );
    const main = [...sessions.values()][0];
    const result = Sessions.killSession(sessions, nextIndex, "aksika", "telegram", main.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(main.status).toBe("ended");
    const live = [...sessions.values()].filter(s => s.userId === "aksika" && s.platform === "telegram" && s.status !== "ended");
    expect(live).toHaveLength(1);
    expect(live[0].active).toBe(true);
  });

  // ── Foreign namespace unchanged ──
  it("does not affect foreign platforms or users", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "C", active: false },
      { userId: "aksika", platform: "tui", type: "A", active: true },
      { userId: "bob", platform: "telegram", type: "A", active: true },
    );
    const beforeForeign = snapshot(sessions).filter(s => s.userId !== "aksika" || s.platform !== "telegram");

    const code = [...sessions.values()].find(s => sessionType(s) === "C")!;
    Sessions.killSession(sessions, nextIndex, "aksika", "telegram", code.shortIndex);

    const afterForeign = snapshot(sessions).filter(s => s.userId !== "aksika" || s.platform !== "telegram");
    expect(afterForeign).toEqual(beforeForeign);
  });

  // ── nextIndex only changes with replacement allocation ──
  it("nextIndex increments only when replacement Main is created", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );

    // Kill inactive Main (no replacement needed — another Main exists)
    const inactiveMain = [...sessions.values()].find(s => !s.active && sessionType(s) === "A")!;
    const r1 = Sessions.killSession(sessions, nextIndex, "aksika", "telegram", inactiveMain.shortIndex);
    expect(typeof r1).not.toBe("string");
    if (typeof r1 === "string") return;
    expect(r1.nextIndex).toBe(nextIndex);

    // Kill the last active Main (replacement created)
    const activeMain = [...sessions.values()].find(s => sessionType(s) === "A" && s.status !== "ended")!;
    const r2 = Sessions.killSession(sessions, r1.nextIndex, "aksika", "telegram", activeMain.shortIndex);
    expect(typeof r2).not.toBe("string");
    if (typeof r2 === "string") return;
    expect(r2.nextIndex).toBeGreaterThan(r1.nextIndex);
  });

  // ── Killed log exists exactly once ──
  it("adds exactly one 'killed' log entry", () => {
    const { sessions, nextIndex } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
    );
    const main = [...sessions.values()][0];
    expect(main.log.filter(l => l.includes("killed"))).toHaveLength(0);

    Sessions.killSession(sessions, nextIndex, "aksika", "telegram", main.shortIndex);
    expect(main.log.filter(l => l.includes("killed"))).toHaveLength(1);
  });

  // ── Independent active sessions per platform ──
  it("Telegram and TUI retain independent active sessions after kill", () => {
    const sessions = makeTestSessions();
    const tgMain = Sessions.getActiveSession(sessions, "aksika", "telegram")!;
    Sessions.killSession(sessions, 9, "aksika", "telegram", tgMain.shortIndex);

    const tgActive = Sessions.getActiveSession(sessions, "aksika", "telegram");
    const tuiActive = Sessions.getActiveSession(sessions, "aksika", "tui");
    expect(tgActive).toBeDefined();
    expect(tgActive!.platform).toBe("telegram");
    expect(tuiActive).toBeDefined();
    expect(tuiActive!.platform).toBe("tui");
    expect(tgActive!.id).not.toBe(tuiActive!.id);
  });
});

describe("explicit vs implicit end equivalence (#1331)", () => {
    it("produces identical state for the same active target", () => {
      const { sessions: s1, nextIndex: ni1 } = buildSessions(
        { userId: "aksika", platform: "telegram", type: "A", active: true },
        { userId: "aksika", platform: "telegram", type: "C", active: false },
      );
      const { sessions: s2, nextIndex: ni2 } = buildSessions(
        { userId: "aksika", platform: "telegram", type: "A", active: true },
        { userId: "aksika", platform: "telegram", type: "C", active: false },
      );

      const activeMain = Sessions.getActiveSession(s1, "aksika", "telegram")!;
      const implicit = Sessions.endSession(s1, ni1, "aksika", "telegram");
      expect(typeof implicit).not.toBe("string");
      const explicit = Sessions.endSession(s2, ni2, "aksika", "telegram", activeMain.shortIndex);
      expect(typeof explicit).not.toBe("string");

      if (typeof implicit === "string" || typeof explicit === "string") return;

      expect(sessionType(implicit.ended)).toBe("A");
      expect(sessionType(explicit.ended)).toBe("A");

      const state1 = snapshot(s1);
      const state2 = snapshot(s2);
      expect(state1).toEqual(state2);
    });
  });

  // ── Independent active sessions per platform ──
  it("Telegram and TUI retain independent active sessions", () => {
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
