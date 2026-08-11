import { describe, it, expect } from "vitest";
import type { ManagedSession, SessionType } from "./spin-types.js";
import { sessionType } from "./spin-types.js";
import { createSpinSessionRegistry, type SpinSessionRegistry } from "./spin-sessions.js";

function makeRegistry(): SpinSessionRegistry {
  return createSpinSessionRegistry({ maxTotalSessions: 12 });
}

function makeTestRegistry(): SpinSessionRegistry {
  const registry = makeRegistry();

  // Telegram Main
  const tg = registry.allocate({ type: "A", userId: "aksika", platform: "telegram", chatId: 100 });
  tg.active = true;

  // TUI Main (same user, different platform)
  const tui = registry.allocate({ type: "A", userId: "aksika", platform: "tui", chatId: 0 });
  tui.active = true;  // both active — simulates parallel attachment

  // Background
  registry.allocate({ type: "S", userId: "aksika", platform: "background", chatId: 0 });

  // Another user's session on telegram
  const other = registry.allocate({ type: "A", userId: "bob", platform: "telegram", chatId: 200 });
  other.active = true;

  // Ended session on telegram
  const ended = registry.allocate({ type: "A", userId: "aksika", platform: "telegram", chatId: 100 });
  ended.status = "ended";
  ended.active = false;

  return registry;
}

function lifecycleSnapshot(registry: SpinSessionRegistry): Array<{ id: string; platform: string; active: boolean; status: string }> {
  return [...registry.listAll()].map(s => ({ id: s.id, platform: s.platform, active: s.active, status: s.status }));
}

function findIndex(registry: SpinSessionRegistry, platform: string, type = "A"): number | undefined {
  return [...registry.listAll()].find(s => s.platform === platform && s.id.includes(`_${type}_`) && s.status !== "ended")?.shortIndex;
}

describe("spin-sessions — platform ownership (#1330)", () => {
  describe("switchSession", () => {
    it("succeeds for same-platform target", () => {
      const registry = makeTestRegistry();
      const tgIdx = findIndex(registry, "telegram")!;
      const result = registry.switch("aksika", "telegram", tgIdx);
      expect(typeof result).not.toBe("string");
      expect((result as ManagedSession).platform).toBe("telegram");
    });

    it("rejects foreign-platform target", () => {
      const registry = makeTestRegistry();
      const tuiIdx = findIndex(registry, "tui")!;
      // Try to switch to a TUI session from telegram platform
      const result = registry.switch("aksika", "telegram", tuiIdx);
      expect(typeof result).toBe("string");
      expect(result).toMatch(/not found on telegram/i);
    });

    it("rejects foreign-user target", () => {
      const registry = makeTestRegistry();
      const bobSession = [...registry.listAll()].find(s => s.userId === "bob")!;
      const result = registry.switch("aksika", "telegram", bobSession.shortIndex);
      expect(typeof result).toBe("string");
    });

    it("rejects ended target", () => {
      const registry = makeTestRegistry();
      const ended = registry.allocate({ type: "A", userId: "aksika", platform: "telegram", chatId: 100 });
      ended.status = "ended";
      ended.active = false;
      const result = registry.switch("aksika", "telegram", ended.shortIndex);
      expect(typeof result).toBe("string");
    });

    it("is idempotent when switching to already-active target", () => {
      const registry = makeTestRegistry();
      const tgIdx = findIndex(registry, "telegram")!;
      const before = lifecycleSnapshot(registry);
      const result = registry.switch("aksika", "telegram", tgIdx);
      expect(typeof result).not.toBe("string");
      const after = lifecycleSnapshot(registry);
      expect(after).toEqual(before);
    });

    it("rejected switch performs no mutation", () => {
      const registry = makeTestRegistry();
      const tuiIdx = findIndex(registry, "tui")!;
      const before = lifecycleSnapshot(registry);
      const result = registry.switch("aksika", "telegram", tuiIdx);
      expect(typeof result).toBe("string");
      const after = lifecycleSnapshot(registry);
      expect(after).toEqual(before);
    });

    it("preserves foreign-platform active session after a valid local switch", () => {
      const registry = makeTestRegistry();
      // We have both telegram active and tui active.
      // Create another telegram session, then switch to it.
      const s2 = registry.allocate({ type: "A", userId: "aksika", platform: "telegram", chatId: 100 });
      s2.active = false;

      const tgIdx1 = findIndex(registry, "telegram")!;
      registry.switch("aksika", "telegram", tgIdx1);

      // TUI should still have its own active session
      const tuiActive = [...registry.list("aksika", "tui")].find(s => s.active);
      expect(tuiActive).toBeDefined();
      expect(tuiActive!.platform).toBe("tui");
      expect(tuiActive!.active).toBe(true);
    });
  });

  describe("endSession", () => {
    it("succeeds for same-platform target by index", () => {
      const registry = makeTestRegistry();
      const tgIdx = findIndex(registry, "telegram")!;
      const result = registry.end("aksika", "telegram", tgIdx);
      expect(typeof result).not.toBe("string");
    });

    it("rejects foreign-platform target", () => {
      const registry = makeTestRegistry();
      const tuiIdx = findIndex(registry, "tui")!;
      const result = registry.end("aksika", "telegram", tuiIdx);
      expect(typeof result).toBe("string");
      expect(result).toMatch(/not found on telegram/i);
    });

    it("rejected end performs no mutation", () => {
      const registry = makeTestRegistry();
      const tuiIdx = findIndex(registry, "tui")!;
      const before = lifecycleSnapshot(registry);
      registry.end("aksika", "telegram", tuiIdx);
      const after = lifecycleSnapshot(registry);
      expect(after).toEqual(before);
    });
  });

  describe("killSession", () => {
    it("succeeds for same-platform target", () => {
      const registry = makeTestRegistry();
      const tgIdx = findIndex(registry, "telegram")!;
      const result = registry.kill("aksika", "telegram", tgIdx);
      expect(typeof result).not.toBe("string");
    });

    it("rejects foreign-platform target", () => {
      const registry = makeTestRegistry();
      const tuiIdx = findIndex(registry, "tui")!;
      const result = registry.kill("aksika", "telegram", tuiIdx);
      expect(typeof result).toBe("string");
      expect(result).toMatch(/not found on telegram/i);
    });

    it("rejected kill performs no mutation", () => {
      const registry = makeTestRegistry();
      const tuiIdx = findIndex(registry, "tui")!;
      const before = lifecycleSnapshot(registry);
      registry.kill("aksika", "telegram", tuiIdx);
      const after = lifecycleSnapshot(registry);
      expect(after).toEqual(before);
    });
  });

  describe("pauseSession", () => {
    it("succeeds for same-platform target", () => {
      const registry = makeTestRegistry();
      const tgIdx = findIndex(registry, "telegram")!;
      const result = registry.pause("aksika", "telegram", tgIdx);
      expect(typeof result).not.toBe("string");
    });

    it("rejects foreign-platform target", () => {
      const registry = makeTestRegistry();
      const tuiIdx = findIndex(registry, "tui")!;
      const result = registry.pause("aksika", "telegram", tuiIdx);
      expect(typeof result).toBe("string");
      expect(result).toMatch(/not found on telegram/i);
    });

    it("rejected pause performs no mutation", () => {
      const registry = makeTestRegistry();
      const tuiIdx = findIndex(registry, "tui")!;
      const before = lifecycleSnapshot(registry);
      registry.pause("aksika", "telegram", tuiIdx);
      const after = lifecycleSnapshot(registry);
      expect(after).toEqual(before);
    });
  });

  describe("resumeSession", () => {
    it("succeeds for same-platform paused target", () => {
      const registry = makeTestRegistry();
      const tgIdx = findIndex(registry, "telegram")!;
      registry.pause("aksika", "telegram", tgIdx);
      const result = registry.resume("aksika", "telegram", tgIdx);
      expect(typeof result).not.toBe("string");
    });

    it("rejects foreign-platform target", () => {
      const registry = makeTestRegistry();
      const tuiIdx = findIndex(registry, "tui")!;
      // Pause the tui session first
      registry.pause("aksika", "tui", tuiIdx);
      const result = registry.resume("aksika", "telegram", tuiIdx);
      expect(typeof result).toBe("string");
      expect(result).toMatch(/not found on telegram/i);
    });

    it("rejected resume performs no mutation", () => {
      const registry = makeTestRegistry();
      const tuiIdx = findIndex(registry, "tui")!;
      registry.pause("aksika", "tui", tuiIdx);
      const before = lifecycleSnapshot(registry);
      registry.resume("aksika", "telegram", tuiIdx);
      const after = lifecycleSnapshot(registry);
      expect(after).toEqual(before);
    });
  });

  describe("endSession — local active/Main reconciliation (#1331)", () => {
  function snapshot(registry: SpinSessionRegistry) {
    return [...registry.listAll()].sort((a, b) => a.shortIndex - b.shortIndex).map(s => ({
      id: s.id, userId: s.userId, platform: s.platform,
      type: sessionType(s), active: s.active, status: s.status,
    }));
  }

  function activeIds(registry: SpinSessionRegistry, userId: string, platform: string): string[] {
    return [...registry.listAll()].filter(s => s.userId === userId && s.platform === platform && s.status !== "ended" && s.active).map(s => s.id);
  }

  function mainIds(registry: SpinSessionRegistry, userId: string, platform: string): string[] {
    return [...registry.listAll()].filter(s => s.userId === userId && s.platform === platform && s.status !== "ended" && sessionType(s) === "A").map(s => s.id);
  }

  /** Build a minimal set of sessions for one test case. */
  function buildSessions(...specs: Array<{ userId: string; platform: string; type: SessionType; active?: boolean; ended?: boolean }>): { registry: SpinSessionRegistry } {
    const registry = makeRegistry();
    for (const spec of specs) {
      const r = registry.allocate({ type: spec.type, userId: spec.userId, platform: spec.platform, chatId: 100 });
      r.active = spec.active ?? false;
      if (spec.ended) { r.status = "ended"; r.active = false; }
    }
    return { registry };
  }

  // ── Active Code ended, local Main exists ──
  it("active Code end activates local Main", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "C", active: true },
    );
    const codeSessions = [...registry.listAll()].filter(s => sessionType(s) === "C");
    expect(codeSessions).toHaveLength(1);
    const codeIdx = codeSessions[0].shortIndex;

    const result = registry.end("aksika", "telegram", codeIdx);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    // Code ended
    expect(result.status).toBe("ended");
    expect(result.active).toBe(false);

    // Exactly one active session on telegram — the Main
    const active = activeIds(registry, "aksika", "telegram");
    expect(active).toHaveLength(1);
    const mains = mainIds(registry, "aksika", "telegram");
    expect(mains).toContain(active[0]);
  });

  // ── Inactive Code ended ──
  it("inactive Code end preserves active Main", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "C", active: false },
    );
    const codeSessions = [...registry.listAll()].filter(s => sessionType(s) === "C");
    const codeIdx = codeSessions[0].shortIndex;

    const beforeActive = activeIds(registry, "aksika", "telegram");
    expect(beforeActive).toHaveLength(1);

    const result = registry.end("aksika", "telegram", codeIdx);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    const afterActive = activeIds(registry, "aksika", "telegram");
    expect(afterActive).toEqual(beforeActive);
  });

  // ── Active Main ended, another Main exists ──
  it("active Main end activates remaining Main", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );
    const endTarget = [...registry.listAll()].find(s => s.active)!;
    const main2 = [...registry.listAll()].find(s => !s.active && sessionType(s) === "A")!;

    const result = registry.end("aksika", "telegram", endTarget.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(endTarget.status).toBe("ended");
    expect(main2.active).toBe(true);
    const active = activeIds(registry, "aksika", "telegram");
    expect(active).toHaveLength(1);
    expect(active[0]).toBe(main2.id);
  });

  // ── Inactive Main ended, another Main exists ──
  it("inactive Main end preserves active Main", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );
    const inactiveMain = [...registry.listAll()].find(s => !s.active && sessionType(s) === "A")!;
    const activeMain = [...registry.listAll()].find(s => s.active && sessionType(s) === "A")!;

    const beforeActive = activeIds(registry, "aksika", "telegram");
    const result = registry.end("aksika", "telegram", inactiveMain.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(inactiveMain.status).toBe("ended");
    expect(activeMain.active).toBe(true);
    const afterActive = activeIds(registry, "aksika", "telegram");
    expect(afterActive).toEqual(beforeActive);
  });

  // ── Last active Main ended ──
  it("last active Main end creates active replacement", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
    );
    const main = [...registry.listAll()][0];

    const result = registry.end("aksika", "telegram", main.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(main.status).toBe("ended");

    // Replacement created
    const live = [...registry.listAll()].filter(s => s.userId === "aksika" && s.platform === "telegram" && s.status !== "ended");
    expect(live).toHaveLength(1);
    expect(live[0].id).not.toBe(main.id);
    expect(sessionType(live[0])).toBe("A");
    expect(live[0].active).toBe(true);
  });

  // ── Last inactive Main ended, Code is active ──
  it("last inactive Main end while Code active creates inactive replacement", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: false },
      { userId: "aksika", platform: "telegram", type: "C", active: true },
    );
    const main = [...registry.listAll()].find(s => sessionType(s) === "A")!;
    const code = [...registry.listAll()].find(s => sessionType(s) === "C")!;

    const result = registry.end("aksika", "telegram", main.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(main.status).toBe("ended");

    // Code unchanged, replacement Main exists and is inactive
    expect(code.status).toBe("ready");
    expect(code.active).toBe(true);

    const liveMains = mainIds(registry, "aksika", "telegram");
    const replacement = liveMains.find(id => id !== code.id);
    expect(replacement).toBeDefined();
    const replacementSession = registry.getById(replacement!)!;
    expect(replacementSession.active).toBe(false);

    // Exactly one active — the Code session
    const active = activeIds(registry, "aksika", "telegram");
    expect(active).toHaveLength(1);
    expect(active[0]).toBe(code.id);
  });

  // ── Last inactive Main ended, no active ──
  it("last inactive Main end with no local active creates active replacement", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );
    const main = [...registry.listAll()][0];

    const result = registry.end("aksika", "telegram", main.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(main.status).toBe("ended");

    const live = [...registry.listAll()].filter(s => s.userId === "aksika" && s.platform === "telegram" && s.status !== "ended");
    expect(live).toHaveLength(1);
    expect(live[0].active).toBe(true);
  });

  // ── Foreign namespace unchanged ──
  it("does not affect foreign platforms or users", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "C", active: false },
      { userId: "aksika", platform: "tui", type: "A", active: true },
      { userId: "bob", platform: "telegram", type: "A", active: true },
    );
    const beforeForeign = snapshot(registry).filter(s => s.userId !== "aksika" || s.platform !== "telegram");

    const code = [...registry.listAll()].find(s => sessionType(s) === "C")!;
    registry.end("aksika", "telegram", code.shortIndex);

    const afterForeign = snapshot(registry).filter(s => s.userId !== "aksika" || s.platform !== "telegram");
    expect(afterForeign).toEqual(beforeForeign);
  });

  // ── Allocation index only changes with replacement allocation ──
  it("allocation index increments only when replacement Main is created", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );

    // End inactive Main (no replacement needed — another Main exists)
    const inactiveMain = [...registry.listAll()].find(s => !s.active && sessionType(s) === "A")!;
    const r1 = registry.end("aksika", "telegram", inactiveMain.shortIndex);
    expect(typeof r1).not.toBe("string");
    if (typeof r1 === "string") return;
    const liveAfterFirst = [...registry.listAll()].filter(s => s.userId === "aksika" && s.platform === "telegram" && s.status !== "ended");
    expect(liveAfterFirst).toHaveLength(1);
    const preReplacementIndex = liveAfterFirst[0].shortIndex;

    // End the last active Main (replacement created)
    const activeMain = [...registry.listAll()].find(s => sessionType(s) === "A" && s.status !== "ended")!;
    const r2 = registry.end("aksika", "telegram", activeMain.shortIndex);
    expect(typeof r2).not.toBe("string");
    if (typeof r2 === "string") return;
    const live = [...registry.listAll()].filter(s => s.userId === "aksika" && s.platform === "telegram" && s.status !== "ended");
    expect(live).toHaveLength(1);
    expect(live[0].shortIndex).toBeGreaterThan(preReplacementIndex);
  });

  // ── Ended log exists exactly once ──
  it("adds exactly one 'ended' log entry", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
    );
    const main = [...registry.listAll()][0];
    expect(main.log.filter(l => l.includes("ended"))).toHaveLength(0);

    registry.end("aksika", "telegram", main.shortIndex);
    expect(main.log.filter(l => l.includes("ended"))).toHaveLength(1);
  });

  describe("killSession — platform reconciliation (#1346)", () => {
  // Scenario references mimic endSession (#1331) — identical expected outcomes.

  // ── Kill active Code, Main exists but inactive → Main activates ──
  it("killed active Code activates local Main", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: false },
      { userId: "aksika", platform: "telegram", type: "C", active: true },
    );
    const code = [...registry.listAll()].find(s => sessionType(s) === "C")!;
    const result = registry.kill("aksika", "telegram", code.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(result.id).toBe(code.id);
    expect(code.status).toBe("ended");
    expect(code.active).toBe(false);
    const main = [...registry.listAll()].find(s => sessionType(s) === "A" && s.status !== "ended")!;
    expect(main.active).toBe(true);
  });

  // ── Kill inactive Code, Main is active → Main stays active ──
  it("inactive Code kill preserves active Main", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "C", active: false },
    );
    const code = [...registry.listAll()].find(s => sessionType(s) === "C")!;
    registry.kill("aksika", "telegram", code.shortIndex);

    const main = [...registry.listAll()].find(s => sessionType(s) === "A")!;
    expect(main.active).toBe(true);
    expect(main.status).not.toBe("ended");
  });

  // ── Kill active Main with spare → other Main activates ──
  it("active Main kill activates remaining Main", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );
    const activeMain = [...registry.listAll()].find(s => s.active)!
    const result = registry.kill("aksika", "telegram", activeMain.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(result.active).toBe(false);
    const remaining = [...registry.listAll()].find(s => sessionType(s) === "A" && s.status !== "ended")!;
    expect(remaining.active).toBe(true);
    expect(remaining.id).not.toBe(activeMain.id);
  });

  // ── Kill inactive Main, active exists → no change ──
  it("inactive Main kill preserves active Main", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );
    const inactive = [...registry.listAll()].find(s => !s.active)!;
    registry.kill("aksika", "telegram", inactive.shortIndex);

    const active = [...registry.listAll()].find(s => s.active)!;
    expect(active.status).not.toBe("ended");
    expect(active.id).not.toBe(inactive.id);
  });

  // ── Kill last Main → replacement created (active) ──
  it("last active Main kill creates active replacement", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
    );
    const main = [...registry.listAll()][0];
    const result = registry.kill("aksika", "telegram", main.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(main.status).toBe("ended");
    const live = [...registry.listAll()].filter(s => s.userId === "aksika" && s.platform === "telegram" && s.status !== "ended");
    expect(live).toHaveLength(1);
    expect(live[0].active).toBe(true);
    expect(live[0].shortIndex).toBeGreaterThan(main.shortIndex);
  });

  // ── Kill last inactive Main, no active → active replacement ──
  it("last inactive Main kill with no local active creates active replacement", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );
    const main = [...registry.listAll()][0];
    const result = registry.kill("aksika", "telegram", main.shortIndex);
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") return;

    expect(main.status).toBe("ended");
    const live = [...registry.listAll()].filter(s => s.userId === "aksika" && s.platform === "telegram" && s.status !== "ended");
    expect(live).toHaveLength(1);
    expect(live[0].active).toBe(true);
  });

  // ── Foreign namespace unchanged ──
  it("does not affect foreign platforms or users", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "C", active: false },
      { userId: "aksika", platform: "tui", type: "A", active: true },
      { userId: "bob", platform: "telegram", type: "A", active: true },
    );
    const beforeForeign = snapshot(registry).filter(s => s.userId !== "aksika" || s.platform !== "telegram");

    const code = [...registry.listAll()].find(s => sessionType(s) === "C")!;
    registry.kill("aksika", "telegram", code.shortIndex);

    const afterForeign = snapshot(registry).filter(s => s.userId !== "aksika" || s.platform !== "telegram");
    expect(afterForeign).toEqual(beforeForeign);
  });

  // ── Allocation index only changes with replacement allocation ──
  it("allocation index increments only when replacement Main is created", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
      { userId: "aksika", platform: "telegram", type: "A", active: false },
    );

    // Kill inactive Main (no replacement needed — another Main exists)
    const inactiveMain = [...registry.listAll()].find(s => !s.active && sessionType(s) === "A")!;
    const r1 = registry.kill("aksika", "telegram", inactiveMain.shortIndex);
    expect(typeof r1).not.toBe("string");
    if (typeof r1 === "string") return;
    const liveAfterFirst = [...registry.listAll()].filter(s => s.userId === "aksika" && s.platform === "telegram" && s.status !== "ended");
    expect(liveAfterFirst).toHaveLength(1);
    const preReplacementIndex = liveAfterFirst[0].shortIndex;

    // Kill the last active Main (replacement created)
    const activeMain = [...registry.listAll()].find(s => sessionType(s) === "A" && s.status !== "ended")!;
    const r2 = registry.kill("aksika", "telegram", activeMain.shortIndex);
    expect(typeof r2).not.toBe("string");
    if (typeof r2 === "string") return;
    const live = [...registry.listAll()].filter(s => s.userId === "aksika" && s.platform === "telegram" && s.status !== "ended");
    expect(live).toHaveLength(1);
    expect(live[0].shortIndex).toBeGreaterThan(preReplacementIndex);
  });

  // ── Killed log exists exactly once ──
  it("adds exactly one 'killed' log entry", () => {
    const { registry } = buildSessions(
      { userId: "aksika", platform: "telegram", type: "A", active: true },
    );
    const main = [...registry.listAll()][0];
    expect(main.log.filter(l => l.includes("killed"))).toHaveLength(0);

    registry.kill("aksika", "telegram", main.shortIndex);
    expect(main.log.filter(l => l.includes("killed"))).toHaveLength(1);
  });

  // ── Independent active sessions per platform ──
  it("Telegram and TUI retain independent active sessions after kill", () => {
    const registry = makeTestRegistry();
    const tgMain = [...registry.list("aksika", "telegram")].find(s => s.active)!;
    registry.kill("aksika", "telegram", tgMain.shortIndex);

    const tgActive = [...registry.list("aksika", "telegram")].find(s => s.active);
    const tuiActive = [...registry.list("aksika", "tui")].find(s => s.active);
    expect(tgActive).toBeDefined();
    expect(tgActive!.platform).toBe("telegram");
    expect(tuiActive).toBeDefined();
    expect(tuiActive!.platform).toBe("tui");
    expect(tgActive!.id).not.toBe(tuiActive!.id);
  });
});

  describe("explicit vs implicit end equivalence (#1331)", () => {
    it("produces identical state for the same active target", () => {
      const { registry: s1 } = buildSessions(
        { userId: "aksika", platform: "telegram", type: "A", active: true },
        { userId: "aksika", platform: "telegram", type: "C", active: false },
      );
      const { registry: s2 } = buildSessions(
        { userId: "aksika", platform: "telegram", type: "A", active: true },
        { userId: "aksika", platform: "telegram", type: "C", active: false },
      );

      const activeMain = [...s1.list("aksika", "telegram")].find(s => s.active)!;
      const implicit = s1.end("aksika", "telegram");
      expect(typeof implicit).not.toBe("string");
      const explicit = s2.end("aksika", "telegram", activeMain.shortIndex);
      expect(typeof explicit).not.toBe("string");

      if (typeof implicit === "string" || typeof explicit === "string") return;

      expect(sessionType(implicit)).toBe("A");
      expect(sessionType(explicit)).toBe("A");

      const state1 = snapshot(s1);
      const state2 = snapshot(s2);
      expect(state1).toEqual(state2);
    });
  });

  // ── Independent active sessions per platform ──
  it("Telegram and TUI retain independent active sessions", () => {
    const registry = makeTestRegistry();
    const tgActive = [...registry.list("aksika", "telegram")].find(s => s.active);
    const tuiActive = [...registry.list("aksika", "tui")].find(s => s.active);
    expect(tgActive).toBeDefined();
    expect(tgActive!.platform).toBe("telegram");
    expect(tuiActive).toBeDefined();
    expect(tuiActive!.platform).toBe("tui");
    expect(tgActive!.id).not.toBe(tuiActive!.id);
  });
});
});
