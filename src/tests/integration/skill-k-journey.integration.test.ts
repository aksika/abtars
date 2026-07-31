/**
 * skill-k-journey.integration.test.ts — #1432 focused production-shaped K E2E.
 *
 * Boots the real task store, ScheduledTaskRunner, Spin/session manager, skill
 * manager (singleton), and message pipeline against a temporary abtars home.
 * Only the provider transport, platform delivery, and filesystem roots are
 * doubled. Protects the escaped regression where unit pieces existed but
 * scheduled launch, session identity, and inbound routing were never connected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IKiroTransport } from "../../components/transport/kiro-transport.js";
import type { PlatformAdapter, InboundMessage } from "../../types/platform.js";

describe("#1432 K interactive skill journey", () => {
  let home: string;
  let board: typeof import("../../components/tasks/kanban-board.js");
  let spin: import("../../components/spin.js").Spin;
  let skillManager: import("../../components/skill-session.js").SkillSessionManager;
  let handleInboundMessage: typeof import("../../components/message-pipeline.js").handleInboundMessage;
  let CronQueue: typeof import("../../components/tasks/task-queue.js").CronQueue;
  let taskStore: typeof import("../../components/tasks/task-store.js");
  let record: { prompts: Array<{ sessionKey: string; prompt: string; agent: string }> };

  const MASTER = "alex";
  const TARGET = { userId: "maria", platform: "telegram", chatId: "42424242" };
  const WRONG = { userId: "maria", platform: "telegram", chatId: "9999999999" };

  function makeFakeRuntime() {
    return {
      session: async (agent: string) => {
        const transport = makeFakeTransport();
        transport.sendPrompt = async (sessionKey: string, prompt: string) => {
          record.prompts.push({ sessionKey, prompt, agent });
          return "Hello from the fake tutor!";
        };
        return {
          sendPrompt: async (sessionKey: string, prompt: string) => {
            record.prompts.push({ sessionKey, prompt, agent });
            return "Hello from the fake tutor!";
          },
          destroy: async () => { transport.destroyed = true; },
          get isReady() { return true; },
          get transport() { return transport; },
        };
      },
      openExecution: async () => { throw new Error("openExecution must not be used in the K journey"); },
      lastUsage: () => null,
    };
  }

  function makeFakeTransport(): IKiroTransport & { destroyed: boolean } {
    return {
      destroyed: false,
      initialize: async () => {},
      sendPrompt: async () => "Hello from the fake tutor!",
      resetSession: async () => {},
      sendInterrupt: async () => {},
      destroy: () => { /* noop */ },
      get isReady() { return true; },
      contextPercent: -1,
      answerOnly: "",
      toolCallsSucceeded: 0,
      intermediateDeliveredText: "",
      transportCommands: [],
    } as unknown as IKiroTransport & { destroyed: boolean };
  }

  function makeAdapter(sent: Array<{ channelId: string; text: string }>): PlatformAdapter {
    return {
      name: "telegram",
      capabilities: { voice: false, reactions: false, typing: false, threads: true },
      start: async () => {},
      stop: () => {},
      authorize: () => true,
      sendMessage: async (channelId, text) => { sent.push({ channelId, text }); return 1; },
      chunkResponse: (t) => [t],
      sendTyping: async () => {},
      setReaction: async () => {},
      downloadVoice: async () => Buffer.from(""),
      sendVoice: async () => {},
      editMessage: async () => {},
    };
  }

  function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
    return {
      platform: "telegram",
      channelId: TARGET.chatId,
      userId: TARGET.userId,
      senderId: TARGET.chatId,
      senderName: TARGET.userId,
      text: "hola",
      timestamp: Date.now(),
      isGroup: false,
      isVoice: false,
      ...overrides,
    };
  }

  function installSkills(timeout: number): void {
    const dir = join(home, "skills", "custom", "tutor");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skill.json"), JSON.stringify({
      interactive: true,
      timeout,
      contextPath: "workspace/tutor/${userId}/CONTEXT.md",
    }));
    writeFileSync(join(dir, "SKILL.md"), "# Tutor\nTeach Spanish using the Feynman method.");
    const ctxDir = join(home, "workspace", "tutor", TARGET.userId);
    mkdirSync(ctxDir, { recursive: true });
    writeFileSync(join(ctxDir, "CONTEXT.md"), "Progress: beginner. Likes: food, music.");
  }

  async function pipelineDeps() {
    return {
      transport: makeFakeTransport(),
      config: { workingDir: home },
      startedAt: Date.now(),
      memoryRuntime: null,
      memoryConfig: { memoryEnabled: false, memoryDir: home },
      conversationBuffer: { push: vi.fn(), drain: () => null, clear: vi.fn() },
      idleSave: { reset: vi.fn(), save: vi.fn(), getTimers: () => new Map(), clearAll: vi.fn() },
      nlmConfig: { enabled: false },
      sttConfig: null,
      ttsConfig: null,
      sessionManager: spin,
      updateCtxStart: vi.fn(),
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    home = join(tmpdir(), `abtars-k-journey-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "users.json"), JSON.stringify({
      users: [
        { userId: MASTER, role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 1111111111 } },
        { userId: TARGET.userId, role: "user", maxClass: 1, tools: [], platforms: { telegram: Number(TARGET.chatId) } },
      ],
    }));
    record = { prompts: [] };
    board = await import("../../components/tasks/kanban-board.js");
    const { spin: spinSingleton } = await import("../../components/spin.js");
    spin = spinSingleton;
    spin.setRuntime(makeFakeRuntime() as never);
    const { skillSessionManager } = await import("../../components/skill-session.js");
    skillManager = skillSessionManager;
    ({ handleInboundMessage } = await import("../../components/message-pipeline.js"));
    ({ CronQueue } = await import("../../components/tasks/task-queue.js"));
    taskStore = await import("../../components/tasks/task-store.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  async function waitForIdle(queue: { currentJob: unknown }): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (queue.currentJob && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(queue.currentJob).toBeNull();
  }

  it("runs the full scheduled K journey: launch, settlement, reuse, isolation, stop, timeout, restart, fallback", async () => {
    installSkills(60);
    const sent: Array<{ channelId: string; text: string }> = [];
    const adapter = makeAdapter(sent);

    // ── Phase 1: due scheduled skill task → one opening, one settlement ──
    const entry: import("../../components/tasks/task-types.js").ScheduledTask = {
      id: "spanish-daily",
      enabled: true,
      priority: "medium",
      chatId: TARGET.chatId,
      delivery: "announce",
      schedule: "* * * * *",
      kind: "agent",
      prompt: "Start today's short Spanish tutoring session.",
      agent: "professor",
      interaction: { mode: "skill", skill: "tutor", target: TARGET },
      orchestration: { maxAgents: 1 },
    };
    taskStore.writeEntry(entry);
    const stored = taskStore.readEntry("spanish-daily")!;
    const queue = new CronQueue("unused", home);
    queue.enqueue(stored, true);
    await waitForIdle(queue);

    // One opening model call, through a real K session.
    expect(record.prompts).toHaveLength(1);
    const launchPrompt = record.prompts[0]!.prompt;
    expect(launchPrompt).toContain("[INTERACTIVE SKILL: tutor]");
    expect(launchPrompt).toContain("Feynman method");
    expect(launchPrompt).toContain("[SKILL CONTEXT]");
    expect(launchPrompt).toContain("Progress: beginner");
    expect(launchPrompt).not.toContain("SOUL");

    // The scheduled run settled while the K binding stays live.
    const cards = board.kanbanList("*");
    const skillCards = cards.filter(c => c.type === "K");
    expect(skillCards).toHaveLength(1);
    expect(skillCards[0]!.status).toBe("done");
    expect(skillCards[0]!.delivery_mode).toBe("announce");
    const binding = skillManager.list(TARGET);
    expect(binding).toBeDefined();
    expect(binding!.skillName).toBe("tutor");

    // ── Phase 2: pipeline turns — two matching messages reuse one K transport ──
    const deps = await pipelineDeps();
    const kSessionId = binding!.sessionId!;
    await handleInboundMessage(makeMsg({ text: "que es ser?" }), adapter, deps);
    await handleInboundMessage(makeMsg({ text: "y estar?" }), adapter, deps);
    const inboundTurns = record.prompts.slice(1);
    expect(inboundTurns).toHaveLength(2);
    expect(inboundTurns[0]!.sessionKey).toBe(kSessionId);
    expect(inboundTurns[1]!.sessionKey).toBe(kSessionId);
    expect(inboundTurns[1]!.prompt).toContain("y estar?");
    expect(inboundTurns[1]!.prompt).not.toContain("[INTERACTIVE SKILL: tutor]");
    expect(sent.some(s => s.text.includes("fake tutor"))).toBe(true);

    // A (master) session was never touched by the K conversation.
    const aSession = spin.getActiveSession(MASTER, "telegram");
    expect(aSession.id).toContain("_A_");
    expect(aSession.messageCount).toBe(0);

    // ── Phase 3: wrong-address traffic reaches its own A session ──
    const wrongDeps = await pipelineDeps();
    await handleInboundMessage(makeMsg({ channelId: WRONG.chatId, text: "hola desde otro chat" }), adapter, wrongDeps);
    const wrongTurns = record.prompts.filter(p => p.prompt.includes("hola desde otro chat"));
    expect(wrongTurns).toHaveLength(1);
    expect(wrongTurns[0]!.sessionKey).toContain("_A_");

    // ── Phase 4: explicit stop returns routing to the unchanged A ──
    expect(await skillManager.stop(TARGET, "explicit")).toBe(true);
    expect(await skillManager.stop(TARGET, "explicit")).toBe(false);
    const afterStop: Array<{ channelId: string; text: string }> = [];
    const afterStopAdapter = makeAdapter(afterStop);
    await handleInboundMessage(makeMsg({ text: "sigo aqui" }), afterStopAdapter, deps);
    const stopTurn = record.prompts[record.prompts.length - 1]!;
    expect(stopTurn.sessionKey).toContain("_A_");
    expect(aSession.id).toContain("_A_");
    expect(spin.getActiveSession(MASTER, "telegram").id).toBe(aSession.id);
    void afterStop;

    // ── Phase 5: inactivity timeout (timeout=60s, expire via injected time) ──
    // The singleton uses real time; drive the same manager semantics through
    // the shared store: launch a fresh binding, then advance its deadline.
    const { SkillSessionManager } = await import("../../components/skill-session.js");
    const { SkillSessionStore, scopeKeyOf } = await import("../../components/skill-session-store.js");
    let fakeNow = Date.now();
    const store2 = new SkillSessionStore({ file: join(home, "state", "skill-sessions.json"), now: () => fakeNow });
    const mgr2 = new SkillSessionManager({ store: store2, now: () => fakeNow, scheduleTimer: () => undefined, spin: spin as never });
    const r2 = await mgr2.launch({ skill: "tutor", agent: "professor", target: TARGET, message: "hola de nuevo" });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(mgr2.resolveForInbound(TARGET).kind).toBe("active");
    fakeNow += 61_000;
    mgr2.checkExpiry();
    expect(mgr2.list(TARGET)).toBeUndefined();
    const store3 = new SkillSessionStore({ file: join(home, "state", "skill-sessions.json"), now: () => fakeNow });
    expect(store3.get(scopeKeyOf(TARGET))).toBeUndefined();

    // ── Phase 6: restart rehydration — fresh manager over durable state ──
    const { SkillSessionStore: StoreRe } = await import("../../components/skill-session-store.js");
    const freshStore = new StoreRe({ file: join(home, "state", "skill-sessions.json") });
    const mgr3 = new SkillSessionManager({ store: freshStore, scheduleTimer: () => undefined, spin: spin as never });
    // Re-launch first so durable state exists (timeout phase cleared it).
    const r3 = await mgr3.launch({ skill: "tutor", agent: "professor", target: TARGET, message: "otra sesion" });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;

    const StoreRestart = await import("../../components/skill-session-store.js");
    const restartStore = new StoreRestart.SkillSessionStore({ file: join(home, "state", "skill-sessions.json") });
    const restarted = new SkillSessionManager({ store: restartStore, scheduleTimer: () => undefined, spin: spin as never });
    const route = restarted.resolveForInbound(TARGET);
    expect(route.kind).toBe("active");
    if (route.kind !== "active") return;
    expect(route.needsBootstrap).toBe(true);
    const prep1 = restarted.prepareBootstrap(TARGET, "hola de nuevo");
    expect(prep1.kind).toBe("bootstrap");
    if (prep1.kind !== "bootstrap") return;
    expect(prep1.bootstrap).toContain("[INTERACTIVE SKILL: tutor]");
    expect(prep1.bootstrap).toContain("Feynman method");
    expect(prep1.bootstrap).toContain("Progress: beginner");
    // Exactly once: completeInbound clears the flag only after a successful
    // turn; the next prep finds the binding bootstrapped.
    restarted.completeInbound(TARGET);
    expect(restarted.prepareBootstrap(TARGET, "hola de nuevo").kind).toBe("resumed");

    // ── Phase 7: removed skill after restart → binding cleared, fallback to A ──
    rmSync(join(home, "skills", "custom", "tutor"), { recursive: true, force: true });
    const StoreGone = await import("../../components/skill-session-store.js");
    const goneStore = new StoreGone.SkillSessionStore({ file: join(home, "state", "skill-sessions.json") });
    const gone = new SkillSessionManager({ store: goneStore, scheduleTimer: () => undefined, spin: spin as never });
    const goneRoute = gone.resolveForInbound(TARGET);
    expect(goneRoute.kind).toBe("fallback_to_main");
    expect(gone.list(TARGET)).toBeUndefined();
    // The same inbound message routes to A exactly once afterwards.
    expect(gone.resolveForInbound(TARGET).kind).toBe("none");
  });
});
