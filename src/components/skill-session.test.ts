/**
 * skill-session.test.ts — SkillSessionManager lifecycle (#1432).
 * Protects: real K session identity, non-active allocation, reuse,
 * validated replacement, exact-address isolation, explicit stop, inactivity
 * timeout, restart rehydration, A fallback, and unchanged A.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillSessionManager } from "./skill-session.js";
import { SkillSessionStore, scopeKeyOf } from "./skill-session-store.js";
import { classifyContent } from "./clean-response.js";
import type { ManagedSession, SessionType } from "./spin-types.js";
import type { SkillSpinFacade } from "./skill-session.js";

/**
 * #1540: spin-sessions no longer exposes raw allocation over a caller-owned
 * Map. This test-local helper builds the same ManagedSession shape the old
 * allocateSession produced, so the fake facade keeps its observable contract.
 */
function allocateSession(
  sessions: Map<string, ManagedSession>, idx: number,
  type: SessionType, userId: string, platform: string, chatId: number,
): { session: ManagedSession; nextIndex: number } {
  const ts = Math.floor(Date.now() / 1000);
  const session: ManagedSession = {
    id: `${ts}_${type}_${String(idx + 1).padStart(2, "0")}`,
    userId, platform, chatId,
    delivery: "simple",
    active: false,
    status: "ready",
    idleTimeoutMs: 7200000,
    lastActiveAt: Date.now(),
    messageCount: 0, tokenCount: 0, toolCallCount: 0,
    log: [],
    shortIndex: idx + 1,
    busy: false, queue: [], fullMode: false, pendingStart: false,
    seen: false, compacting: false, ctxWarned: false, compactFailures: 0,
    primingTerms: [], completions: [],
    instructionQueue: [],
    steeringAccepting: false,
  };
  sessions.set(session.id, session);
  return { session, nextIndex: idx + 1 };
}

let home: string;
let storeFile: string;

function makeSkills(): void {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "users.json"), JSON.stringify({
    users: [
      { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } },
      { userId: "ada", role: "user", maxClass: 1, tools: [], platforms: { telegram: 42 } },
    ],
  }));
  const dir = join(home, "skills", "custom", "spanish-tutor");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill.json"), JSON.stringify({
    interactive: true,
    timeout: 60,
    contextPath: "workspace/spanish/${userId}/CONTEXT.md",
  }));
  writeFileSync(join(dir, "SKILL.md"), "# Spanish Tutor\nTeach Spanish.");
  mkdirSync(join(home, "workspace", "spanish", "ada"), { recursive: true });
  writeFileSync(join(home, "workspace", "spanish", "ada", "CONTEXT.md"), "Student: beginner. Likes: food.");
  const dir2 = join(home, "skills", "custom", "french-tutor");
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "skill.json"), JSON.stringify({ interactive: true, timeout: 60 }));
  writeFileSync(join(dir2, "SKILL.md"), "# French Tutor\nTeach French.");
}

interface FakeSpin {
  facade: SkillSpinFacade;
  sessions: Map<string, ManagedSession>;
  prompts: Array<{ sessionId: string; prompt: string }>;
  finalized: string[];
  next: () => { session: ManagedSession; nextIndex: number };
}

function fakeSpin(): FakeSpin {
  const sessions = new Map<string, ManagedSession>();
  const prompts: Array<{ sessionId: string; prompt: string }> = [];
  const finalized: string[] = [];
  let idx = 0;
  const next = (): { session: ManagedSession; nextIndex: number } => {
    const r = allocateSession(sessions, idx++, "K", "ada", "telegram", 42);
    sessions.set(r.session.id, r.session);
    return r;
  };
  const facade: SkillSpinFacade = {
    getSessionById: (id) => sessions.get(id),
    createSubSession: () => {
      const r = allocateSession(sessions, idx++, "K", "ada", "telegram", 42);
      sessions.set(r.session.id, r.session);
      return r.session;
    },
    ensureSessionTransport: async (session) => {
      if (session.status === "ended") throw new Error("Session ended");
      session.transport = {} as ManagedSession["transport"];
    },
    spin: async ({ sessionId, prompt }) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      if (session.status === "ended") throw new Error("session ended");
      prompts.push({ sessionId, prompt });
      // #1651: mirror the production contract — spin reports the classified
      // outcome alongside the verbatim result, and the launch guard reads it.
      const result = `response-to:${prompt.slice(0, 40)}`;
      return { sessionId, result, outcome: classifyContent(result) };
    },
    finalizeExactSession: (sessionId, expectedUserId) => {
      const s = sessions.get(sessionId);
      if (!s || s.userId !== expectedUserId) return false;
      if (s.status !== "ended") {
        s.status = "ended";
        s.active = false;
        s.transport = undefined;
        finalized.push(sessionId);
      }
      return true;
    },
  };
  return { facade, sessions, prompts, finalized, next };
}

function makeManager(spin: FakeSpin, now?: () => number, timer?: (fn: () => void, ms: number) => unknown): SkillSessionManager {
  const store = new SkillSessionStore({ file: storeFile });
  const mgr = new SkillSessionManager({ store, now, scheduleTimer: timer ?? (() => undefined), spin: spin.facade });
  mgr.ensureLoaded();
  return mgr;
}

const TARGET = { userId: "ada", platform: "telegram", chatId: "42" };

beforeEach(() => {
  home = join(tmpdir(), `abtars-skill-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  storeFile = join(home, "state", "skill-sessions.json");
  process.env["ABTARS_HOME"] = home;
  makeSkills();
});

afterEach(() => {
  delete process.env["ABTARS_HOME"];
  rmSync(home, { recursive: true, force: true });
});

describe("SkillSessionManager launch", () => {
  it("launches K with a real non-active K session and the selected agent", async () => {
    const spin = fakeSpin();
    const mgr = makeManager(spin);
    const result = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session = spin.sessions.get(result.sessionId)!;
    expect(session.id).toContain("_K_");
    expect(session.active).toBe(false);
    expect(session.executionAgent).toBe("professor");
    expect(session.userId).toBe("ada");
    expect(spin.prompts[0]!.prompt).toContain("[INTERACTIVE SKILL: spanish-tutor]");
    expect(spin.prompts[0]!.prompt).toContain("Teach Spanish.");
    expect(spin.prompts[0]!.prompt).toContain("[SKILL CONTEXT]");
    expect(spin.prompts[0]!.prompt).toContain("[USER MESSAGE]\nhola");
    expect(existsSync(storeFile)).toBe(true);
    const durable = JSON.parse(require("node:fs").readFileSync(storeFile, "utf-8"));
    expect(durable.bindings[0]).toMatchObject({ skillName: "spanish-tutor", chatId: "42", agent: "professor" });
    expect(JSON.stringify(durable)).not.toContain("sessionId");
  });

  it("rejects an unregistered target user with a structured error", async () => {
    const spin = fakeSpin();
    const mgr = makeManager(spin);
    const result = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: { ...TARGET, userId: "nobody" }, message: "hola" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unknown_target");
    expect(spin.prompts).toHaveLength(0);
    expect(mgr.list({ ...TARGET, userId: "nobody" })).toBeUndefined();
  });

  it("launch failure removes the binding and the K transport", async () => {
    const spin = fakeSpin();
    spin.facade.spin = async () => { throw new Error("provider down"); };
    const mgr = makeManager(spin);
    const result = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("transport_failed");
    expect(mgr.list(TARGET)).toBeUndefined();
    expect(spin.finalized).toHaveLength(1);
  });

  it.each<[string, string]>([
    ["a reaction-only", "[REACT:👋]"],
    ["a no-reply", "[NO_REPLY]"],
    ["an empty", ""],
  ])("#1651 v2: bootstrap fails when the first K turn yields %s outcome — only text content activates a skill", async (_label, raw) => {
    const spin = fakeSpin();
    spin.facade.spin = async ({ sessionId, prompt }) => {
      const session = spin.sessions.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      return { sessionId, result: raw, outcome: classifyContent(raw) };
    };
    const mgr = makeManager(spin);
    const result = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("empty model response");
    expect(mgr.list(TARGET)).toBeUndefined();
  });

  it("same skill + same agent reuses the same K session", async () => {
    const spin = fakeSpin();
    const mgr = makeManager(spin);
    const r1 = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    const r2 = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "adios" });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.sessionId).toBe(r1.sessionId);
    expect(r2.kind).toBe("resumed");
    expect(spin.sessions.size).toBe(1);
    expect(spin.prompts).toHaveLength(2);
  });

  it("agent change terminates old K and launches a replacement", async () => {
    const spin = fakeSpin();
    const mgr = makeManager(spin);
    const r1 = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    const r2 = await mgr.launch({ skill: "spanish-tutor", agent: "task", target: TARGET, message: "hola" });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.sessionId).not.toBe(r1.sessionId);
    expect(spin.finalized).toContain(r1.sessionId);
    expect(spin.sessions.get(r1.sessionId)!.status).toBe("ended");
  });

  it("skill change terminates old K and binds the new one", async () => {
    const spin = fakeSpin();
    const mgr = makeManager(spin);
    const r1 = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    const r2 = await mgr.launch({ skill: "french-tutor", agent: "professor", target: TARGET, message: "bonjour" });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.sessionId).not.toBe(r1.sessionId);
    expect(spin.finalized).toContain(r1.sessionId);
    expect(mgr.list(TARGET)).toMatchObject({ skillName: "french-tutor" });
  });

  it("replacement validation failure keeps the old binding usable", async () => {
    const spin = fakeSpin();
    const mgr = makeManager(spin);
    const r1 = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    expect(r1.ok).toBe(true);
    const r2 = await mgr.launch({ skill: "no-such-skill", agent: "professor", target: TARGET, message: "x" });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.code).toBe("not_found");
    expect(mgr.list(TARGET)).toMatchObject({ skillName: "spanish-tutor" });
    expect(spin.finalized).toHaveLength(0);
    const route = await mgr.resolveForInbound(TARGET);
    expect(route.kind).toBe("active");
  });

  it("capacity failure during replacement keeps the old binding usable", async () => {
    const spin = fakeSpin();
    const originalCreate = spin.facade.createSubSession;
    let creates = 0;
    spin.facade.createSubSession = (...args) => {
      creates++;
      return creates === 1 ? originalCreate(...args) : "Max sessions reached";
    };
    const mgr = makeManager(spin);
    const first = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replacement = await mgr.launch({ skill: "french-tutor", agent: "task", target: TARGET, message: "bonjour" });
    expect(replacement.ok).toBe(false);
    if (replacement.ok) return;
    expect(replacement.error.code).toBe("capacity_exhausted");
    expect(mgr.list(TARGET)).toMatchObject({ skillName: "spanish-tutor", sessionId: first.sessionId });
    expect(spin.finalized).toEqual([]);
    expect((await mgr.resolveForInbound(TARGET)).kind).toBe("active");
  });
});

describe("SkillSessionManager routing", () => {
  it("is exact-address isolated", async () => {
    const spin = fakeSpin();
    const mgr = makeManager(spin);
    await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    expect((await mgr.resolveForInbound(TARGET)).kind).toBe("active");
    expect((await mgr.resolveForInbound({ ...TARGET, chatId: "43" })).kind).toBe("none");
    expect((await mgr.resolveForInbound({ ...TARGET, platform: "discord" })).kind).toBe("none");
    expect((await mgr.resolveForInbound({ ...TARGET, userId: "bob" })).kind).toBe("none");
    expect((await mgr.resolveForInbound({ ...TARGET, threadId: "7" })).kind).toBe("none");
  });

  it("stop is idempotent and ends only the K transport", async () => {
    const spin = fakeSpin();
    const mgr = makeManager(spin);
    await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    const s1 = await mgr.stop(TARGET, "explicit");
    const s2 = await mgr.stop(TARGET, "explicit");
    expect(s1).toBe(true);
    expect(s2).toBe(false);
    expect(spin.finalized).toHaveLength(1);
    expect((await mgr.resolveForInbound(TARGET)).kind).toBe("none");
  });

  it("inactivity timeout ends transport and clears binding; only accepted turns refresh", async () => {
    let nowMs = 1_000_000;
    const spin = fakeSpin();
    const mgr = makeManager(spin, () => nowMs);
    const r = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t0 = nowMs;
    mgr.checkExpiry();
    expect(mgr.list(TARGET)).toBeDefined(); // not expired yet
    nowMs = t0 + 61_000;
    mgr.checkExpiry();
    expect(mgr.list(TARGET)).toBeUndefined();
    await vi.waitFor(() => expect(spin.finalized).toContain(r.sessionId));
  });

  it("completeInbound refreshes the inactivity deadline", async () => {
    let nowMs = 1_000_000;
    const spin = fakeSpin();
    const mgr = makeManager(spin, () => nowMs);
    const r = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    nowMs += 30_000;
    mgr.completeInbound(TARGET);
    nowMs += 30_000;
    mgr.checkExpiry();
    expect(mgr.list(TARGET)).toBeDefined();
    nowMs += 31_000;
    mgr.checkExpiry();
    expect(mgr.list(TARGET)).toBeUndefined();
  });
});

describe("SkillSessionManager restart rehydration", () => {
  it("rehydrates on first matching message with a fresh K and bootstrap flag", async () => {
    const spin1 = fakeSpin();
    const mgr1 = makeManager(spin1);
    const r = await mgr1.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    expect(r.ok).toBe(true);

    // Bridge restart: brand-new manager + store reading the same durable state.
    const spin2 = fakeSpin();
    const mgr2 = makeManager(spin2);
    const route = await mgr2.resolveForInbound(TARGET);
    expect(route.kind).toBe("active");
    if (route.kind !== "active") return;
    expect(route.needsBootstrap).toBe(true);
    const session = spin2.sessions.get(route.sessionId)!;
    expect(session.id).toContain("_K_");
    expect(session.active).toBe(false);
    expect(session.executionAgent).toBe("professor");
    // No model call during rehydration.
    expect(spin2.prompts).toHaveLength(0);

    mgr2.completeInbound(TARGET);
    const route2 = await mgr2.resolveForInbound(TARGET);
    expect(route2.kind).toBe("active");
    if (route2.kind === "active") expect(route2.needsBootstrap).toBe(false);
  });

  it("missing skill after restart clears the binding and falls back to A", async () => {
    const spin1 = fakeSpin();
    const mgr1 = makeManager(spin1);
    await mgr1.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });

    rmSync(join(home, "skills", "custom", "spanish-tutor"), { recursive: true, force: true });

    const mgr2 = makeManager(fakeSpin());
    const route = await mgr2.resolveForInbound(TARGET);
    expect(route.kind).toBe("fallback_to_main");
    expect(mgr2.list(TARGET)).toBeUndefined();
  });

  it("A remains active through K launch and stop", async () => {
    const sessions = new Map<string, ManagedSession>();
    let idx = 0;
    const aSession = allocateSession(sessions, idx++, "A", "ada", "telegram", 42);
    sessions.set(aSession.session.id, aSession.session);
    aSession.session.active = true;
    const finalized: string[] = [];
    const facade: SkillSpinFacade = {
      getSessionById: (id) => sessions.get(id),
      createSubSession: (userId, platform, type) => {
        const r = allocateSession(sessions, idx++, type, userId, platform, 42);
        sessions.set(r.session.id, r.session);
        return r.session;
      },
      ensureSessionTransport: async (session) => {
        if (session.status === "ended") throw new Error("Session ended");
        session.transport = {} as ManagedSession["transport"];
      },
      spin: async ({ sessionId, prompt }) => {
        const session = sessions.get(sessionId);
        if (!session) throw new Error(`unknown session ${sessionId}`);
        const result = `ok:${prompt.slice(0, 20)}`;
        return { sessionId, result, outcome: classifyContent(result) };
      },
      finalizeExactSession: (id, expected) => {
        const s = sessions.get(id);
        if (!s || s.userId !== expected) return false;
        s.status = "ended";
        s.active = false;
        s.transport = undefined;
        finalized.push(id);
        return true;
      },
    };
    const mgr = makeManager({ facade, sessions, prompts: [], finalized, next: () => ({ session: aSession.session, nextIndex: 0 }) });
    const r = await mgr.launch({ skill: "spanish-tutor", agent: "professor", target: TARGET, message: "hola" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(aSession.session.status).toBe("ready");
    expect(aSession.session.active).toBe(true);
    await mgr.stop(TARGET, "explicit");
    expect(aSession.session.status).toBe("ready");
    expect(aSession.session.active).toBe(true);
  });
});
