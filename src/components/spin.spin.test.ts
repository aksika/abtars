/**
 * spin.spin.test.ts — #1271 unified session API tests.
 *
 * Verifies the spin(spec) chokepoint behaves per SessionProfile:
 *  - session resolution (active/singleton/transient)
 *  - lifecycle (call/response/external)
 *  - decorator application
 *  - sessionId reuse (multi-step)
 *  - metadata semantics
 *  - onStepComplete hook
 *  - **Orc parity** — spin({type:"O"}) produces byte-for-byte prompt
 *    byte-for-byte equivalent to pre-refactor executeOrc, with bridge-lock
 *    side effects (orc_active, setActiveOrcCard).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the side-effect modules BEFORE Spin imports them. These are dynamic-imported
// by spin-profiles.ts at runtime, so vi.mock works at the top of the test file.
const orcLockUpdates: Array<string | number | null> = [];
const activeOrcCardUpdates: Array<number | null> = [];
const projectSupervision = new Map<number, unknown>();
let projectStoreReadFails = false;
const callbackSend = vi.fn().mockResolvedValue(undefined);

vi.mock("./transport/bridge-lock-transport.js", () => ({
  updateBridgeLockField: (field: string, val: unknown) => {
    if (field === "orc_active") orcLockUpdates.push(val as string | number | null);
  },
  trackAcpPid: vi.fn(),
}));

vi.mock("./transport/orc-tools.js", () => ({
  setActiveOrcCard: (val: number | null) => activeOrcCardUpdates.push(val),
  setActiveOrcContext: () => {},
  getActiveOrcContext: () => null,
}));

vi.mock("./project-acceptance/project-review-store.js", () => ({
  ProjectReviewStore: class {
    constructor() {
      if (projectStoreReadFails) throw new Error("review store unavailable");
    }
    getSupervision(cardId: number): unknown {
      return projectSupervision.get(cardId);
    }
  },
}));

vi.mock("./peer-transport/index.js", () => ({
  getPeerTransport: () => ({ send: callbackSend }),
}));

// #1599: controlled worker-supervision settlement for the criteria gate tests.
// spin.ts instantiates WorkerSupervisionService directly in finishSpin; the
// mock supplies a per-test collectAndSettle outcome without touching the DB.
const collectAndSettleOutcome = { value: undefined as unknown };
vi.mock("./worker-supervision-service.js", () => ({
  WorkerSupervisionService: class {
    collectAndSettle() { return collectAndSettleOutcome.value as any; }
    getContract() { return undefined; }
    cardHasContract() { return false; }
    renderContractForPrompt() { return ""; }
  },
  validateWorkerRootCriteria: () => null,
}));

vi.mock("./spin-notifications.js", () => ({
  drainOrcNotifications: () => [],
}));

vi.mock("./tasks/kanban-channel.js", () => ({
  channelUnread: () => [],
}));

// Mock kanban-board so spin() tests never write to the real ~/.abtars/kanban/kanban.db.
// Without this mock, every test that calls spin({ type:"O"/"T", goal, source:"user" }) enqueues
// real cards into the production DB, which the running bridge reconciler then delivers to
// Telegram as `Task "X" complete.` spam (boom×60, first×60, init×140, …).
let _nextId = 1;
interface MockCard { id: number; title: string; source: string; status: string; type: string; [key: string]: unknown; }
const _cards = new Map<number, MockCard>();
// #1629: configurable root resolution — defaults to identity (card is its own
// root). Provenance tests install a parent-chain walker or a failure stub.
let resolveRootImpl: ((id: number) => number | undefined) | null = null;
function walkToRoot(id: number): number | undefined {
  const seen = new Set<number>();
  let current: number | undefined = id;
  while (current !== undefined) {
    if (seen.has(current)) return undefined; // cycle
    seen.add(current);
    const card = _cards.get(current);
    if (!card || card.parent_id === undefined) return current;
    current = card.parent_id as number;
  }
  return undefined;
}
vi.mock("./tasks/kanban-board.js", () => ({
  kanbanEnqueue: (title: string, source: string) => {
    const id = _nextId++;
    _cards.set(id, { id, title, source, status: "queued", type: "task" });
    return id;
  },
  kanbanRunning: (id: number) => { const c = _cards.get(id); if (c) c.status = "running"; },
  kanbanComplete: (id: number) => { const c = _cards.get(id); if (c) c.status = "done"; },
  kanbanFail: (id: number) => { const c = _cards.get(id); if (c) c.status = "failed"; },
  kanbanRetryOrFail: (id: number) => { const c = _cards.get(id); if (c) c.status = "failed"; return "failed"; },
  kanbanList: (filter?: string) => {
    const cards = Array.from(_cards.values());
    if (filter === "*") return cards;
    return cards.filter(c => c.status === (filter || "queued"));
  },
  kanbanQueuedDispatchOrder: (now?: number) => {
    const cards = Array.from(_cards.values()).filter(c => c.status === "queued" && (!c.next_retry_at || new Date(c.next_retry_at).getTime() <= (now ?? Date.now())));
    return cards;
  },
  kanbanGetCard: (id: number) => _cards.get(id) ?? null,
  isUnblocked: () => true,
  resolveRootId: (id: number) => resolveRootImpl ? resolveRootImpl(id) : id,
  resolveActiveDescendants: () => [],
  resolveRecentDirectChildren: () => [],
  kanbanGetChildren: () => [],
  kanbanAddTokens: () => {},
  kanbanProgress: () => {},
  // #1411: internal card data accessor for test assertions
  _kanbanGetCardRaw: (id: number) => _cards.get(id) ?? null,
  // #1644: the lease emitter path (attemptId + executionControl present)
  // constructs ExecutorLeaseStore — a no-op in-memory stub is enough here
  // (the worker-supervision service itself is mocked).
  requireTaskDatabase: () => ({
    prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }),
    exec: () => {},
    transaction: (fn: () => unknown) => fn(),
  }),
  _kanbanSetCardField: (id: number, field: string, value: unknown) => {
    const c = _cards.get(id);
    if (c) (c as any)[field] = value;
  },
}));

vi.mock("../utils/local-time.js", () => ({
  localDateTime: () => "2026-07-01 12:00",
}));

vi.mock("./soul-bundle.js", () => ({
  buildSoulBundle: () => "SOUL_BUNDLE",
}));

import { Spin } from "./spin.js";
import { kanbanEnqueue } from "./tasks/kanban-board.js";
import { setUserRegistryOverride, type UserRegistry, type UserEntry } from "./user-registry.js";
import { profileFor, isValidSessionType, SESSION_PROFILES } from "./spin-profiles.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { AgentSession } from "./subagent-runtime.js";

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

function mockTransport(overrides: Partial<IKiroTransport> = {}): IKiroTransport {
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
    ...overrides,
  } as unknown as IKiroTransport;
}

function makeRuntime(opts: {
  completeResponse?: string;
  completeImpl?: (agent: string, prompt: string, o?: any) => Promise<string>;
  sendPromptResponse?: string;
  sendPromptImpl?: (sessionKey: string, prompt: string, image?: { mime: string; base64: string }, context?: any) => Promise<string>;
  lastUsage?: { input: number; output: number } | null;
} = {}) {
  const lastUsage = opts.lastUsage ?? null;
  const agentSession: AgentSession = {
    sendPrompt: vi.fn(opts.sendPromptImpl ?? (async () => opts.sendPromptResponse ?? "agent response")),
    destroy: vi.fn(),
    get isReady() { return true; },
    get transport() {
      const overrides: Partial<IKiroTransport> = {
        lastUsage: vi.fn().mockReturnValue(lastUsage),
      };
      if (opts.sendPromptImpl) {
        overrides.sendPrompt = vi.fn(opts.sendPromptImpl);
      }
      return mockTransport(overrides);
    },
  };
  const sendPromptFn = opts.sendPromptImpl
    ? vi.fn(opts.sendPromptImpl)
    : vi.fn(async () => opts.sendPromptResponse ?? opts.completeResponse ?? "agent response");
  const mockTransportInstance = mockTransport({
    lastUsage: vi.fn().mockReturnValue(lastUsage),
    sendPrompt: sendPromptFn,
  });
  const mockExec = {
    send: vi.fn(async (prompt: string, image?: any, context?: any) => {
      const response = await mockTransportInstance.sendPrompt("mock:exec", prompt, image, context);
      // #1651: mirror production — the executor returns the provider's own
      // string, empty included. It never substitutes a placeholder.
      return response ?? "";
    }),
    close: vi.fn(),
    transport: mockTransportInstance,
    sessionKey: "mock:exec",
    ephemeral: true,
    lastUsage: () => lastUsage,
  };
  return {
    session: vi.fn().mockResolvedValue(agentSession),
    complete: vi.fn(opts.completeImpl ?? (async () => opts.completeResponse ?? "agent response")),
    openExecution: vi.fn(async () => mockExec),
    lastUsage,
  };
}

describe("spin(spec) — unified session API (#1271)", () => {
  let spin: Spin;

  beforeEach(() => {
    spin = new Spin();
    projectSupervision.clear();
    projectStoreReadFails = false;
    callbackSend.mockClear();
    setUserRegistryOverride(makeRegistry([
      makeUser("aksika", "master", 111),
      makeUser("adrika", "user", 222),
    ]));
  });

  afterEach(() => {
    setUserRegistryOverride(null);
  });

  describe("profile registry", () => {
    it("every SessionType has a profile", () => {
      const types = ["A", "B", "C", "T", "P", "S", "O", "W", "D", "H"] as const;
      for (const t of types) {
        expect(SESSION_PROFILES[t]).toBeDefined();
        expect(SESSION_PROFILES[t].agent).toBeTruthy();
      }
    });

    it("O profile uses browsie (not professor)", () => {
      expect(profileFor("O")!.agent).toBe("browsie");
    });

    it("A profile is active + persistent + no decorators", () => {
      const p = profileFor("A")!;
      expect(p.resolution).toBe("active");
      expect(p.transportMode).toBe("persistent");
      expect(p.decorators).toEqual([]);
    });

    it("O profile is singleton with bridge-lock hooks", () => {
      const p = profileFor("O")!;
      expect(p.resolution).toBe("singleton");
      expect(p.transportMode).toBe("persistent");
      expect(p.terminateAfter).toBe("external");
      expect(p.beforePrompt).toBeDefined();
      expect(p.afterPrompt).toBeUndefined();
    });

    it("D profile is external (multi-step persistent)", () => {
      const p = profileFor("D")!;
      expect(p.terminateAfter).toBe("external");
      expect(p.transportMode).toBe("persistent");
    });

    it("S profile is call-terminate (deleted from Map after)", () => {
      const p = profileFor("S")!;
      expect(p.terminateAfter).toBe("call");
      expect(p.transportMode).toBe("oneshot");
    });

    it("T profile gets channel decorator", () => {
      expect(profileFor("T")!.decorators.length).toBeGreaterThanOrEqual(2);
    });

    // #1327: profileFor is now type-safe — returns undefined for unknown types.
    it("profileFor returns undefined for unknown SessionType (#1327)", () => {
      expect(profileFor("bug" as any)).toBeUndefined();
      expect(profileFor("Z" as any)).toBeUndefined();
      expect(profileFor("" as any)).toBeUndefined();
    });

    it("isValidSessionType accepts every registered SessionType (#1327)", () => {
      const valid = ["A", "B", "C", "T", "P", "S", "O", "W", "D", "H"];
      for (const t of valid) {
        expect(isValidSessionType(t)).toBe(true);
      }
    });

    it("isValidSessionType rejects ticket categories and garbage (#1327)", () => {
      expect(isValidSessionType("bug")).toBe(false);
      expect(isValidSessionType("feature")).toBe(false);
      expect(isValidSessionType("task")).toBe(false);
      expect(isValidSessionType("")).toBe(false);
      expect(isValidSessionType(undefined)).toBe(false);
      expect(isValidSessionType(null)).toBe(false);
      expect(isValidSessionType(42)).toBe(false);
    });
  });

  // #1327: spin() with an unknown type used to throw TypeError on
  // `profile.agent` and crash the bridge via unhandledRejection. Now it
  // returns a sensible SpinResult with an error message and (if cardId is
  // provided) marks the card failed.
  describe("defensive guards (Layer A in spin) — #1327", () => {
    it("spin with unknown type returns a fail-soft SpinResult (no crash, no unhandled rejection)", async () => {
      spin.setRuntime(makeRuntime() as any);
      const r = await spin.spin({ type: "bug" as any, prompt: "anything", await: true, userId: "aksika", platform: "telegram", source: "user" });
      expect(r.sessionId).toBe("");
      expect(r.result).toMatch(/\[SYSTEM BUG\] invalid type for Spin dispatch: "bug" is not a SessionType/);
    });

    it("spin with unknown type and a cardId marks the card failed in kanban", async () => {
      spin.setRuntime(makeRuntime() as any);
      // Enqueue a card with a bad type (the mock stores it with type="task" by default;
      // we re-mutate to simulate the real-world "type=bug" card that was the trigger).
      const cardId = kanbanEnqueue("stale card", "agent");
      _cards.get(cardId)!.type = "bug";
      const r = await spin.spin({ type: "bug" as any, goal: "stale", cardId, await: true });
      expect(r.result).toMatch(/invalid type for Spin dispatch/);
      expect(_cards.get(cardId)!.status).toBe("failed");
    });

    it("spin with valid type still works (regression guard)", async () => {
      spin.setRuntime(makeRuntime() as any);
      const r = await spin.spin({ type: "A", prompt: "hi", await: true, userId: "aksika", platform: "telegram", source: "user" });
      expect(r.sessionId).toBeTruthy();
      expect(r.result).not.toMatch(/\[SYSTEM BUG\]/);
    });
  });

  describe("session resolution (no type branches)", () => {
    it("A resolves to active session (auto-create Main)", async () => {
      spin.setRuntime(makeRuntime() as any);
      const r = await spin.spin({ type: "A", prompt: "hi", userId: "aksika", platform: "telegram", await: true });
      expect(r.sessionId).toBeTruthy();
      const usedSession = spin.getSessionById(r.sessionId);
      expect(usedSession).toBeDefined();
      expect(usedSession!.userId).toBe("aksika");
      expect(usedSession!.platform).toBe("telegram");
    });

    it("A persists across turns — same active session id, not response-terminated (#1287)", async () => {
      spin.setRuntime(makeRuntime() as any);
      const r1 = await spin.spin({ type: "A", prompt: "turn 1", userId: "aksika", platform: "telegram", await: true });
      const r2 = await spin.spin({ type: "A", prompt: "turn 2", userId: "aksika", platform: "telegram", await: true });
      // A is external-terminated: the Main session survives a completed turn, so the
      // second turn reuses the SAME session (stable id → continuous conversation context).
      expect(r2.sessionId).toBe(r1.sessionId);
      const s = spin.getSessionById(r1.sessionId);
      expect(s).toBeDefined();
      expect(s!.status).not.toBe("ended");
      expect(s!.active).toBe(true);
      // getActiveSession must return that same session (not auto-create a new one).
      expect(spin.getActiveSession("aksika", "telegram").id).toBe(r1.sessionId);
    });


    it("O reuses the one visible Orc session (singleton)", async () => {
      spin.setRuntime(makeRuntime() as any);
      const r1 = await spin.spin({ type: "O", prompt: "task 1", await: true });
      const r2 = await spin.spin({ type: "O", prompt: "task 2", await: true });
      expect(r1.sessionId).toBe(r2.sessionId);
    });

    it("S creates fresh session each time (transient)", async () => {
      spin.setRuntime(makeRuntime() as any);
      const r1 = await spin.spin({ type: "S", prompt: "x", await: true });
      const r2 = await spin.spin({ type: "S", prompt: "y", await: true });
      expect(r1.sessionId).not.toBe(r2.sessionId);
      // S should be deleted from Map after call
      expect(spin.getSessionById(r1.sessionId)).toBeUndefined();
      expect(spin.getSessionById(r2.sessionId)).toBeUndefined();
    });

    it("sessionId reuse reuses the same session (multi-step)", async () => {
      const transport = mockTransport();
      const runtime = makeRuntime({
        sendPromptImpl: async () => "step result",
        lastUsage: { input: 10, output: 20 },
      });
      // Pre-allocate a D session with the transport attached
      const dSession = spin.createSubSession("aksika", "telegram", "D") as import("./spin-types.js").ManagedSession;
      dSession.transport = transport;

      spin.setRuntime(runtime as any);

      const r1 = await spin.spin({ type: "D", sessionId: dSession.id, prompt: "step1", await: true });
      const r2 = await spin.spin({ type: "D", sessionId: dSession.id, prompt: "step2", await: true });
      expect(r1.sessionId).toBe(dSession.id);
      expect(r2.sessionId).toBe(dSession.id);
      // Persistent send uses session.transport.sendPrompt, not runtime.complete
      expect((transport.sendPrompt as any).mock.calls.length).toBe(2);
      expect(runtime.complete).not.toHaveBeenCalled();
    });

    it("threads durableContextIntent through to the session transport unchanged (#1529)", async () => {
      const transport = mockTransport();
      const runtime = makeRuntime();
      const dSession = spin.createSubSession("aksika", "telegram", "D") as import("./spin-types.js").ManagedSession;
      dSession.transport = transport;
      spin.setRuntime(runtime as any);

      const intent = { mode: "required_unavailable" as const, reason: "record_failed" as const };
      const r = await spin.spin({ type: "D", sessionId: dSession.id, prompt: "step1", durableContextIntent: intent, await: true });
      expect(r.sessionId).toBe(dSession.id);
      const context = (transport.sendPrompt as any).mock.calls[0]?.[3];
      expect(context.durableContextIntent).toEqual(intent);
    });

    it("A continuation does NOT overwrite existing session transport", async () => {
      const userKeyedTransport = mockTransport();
      const runtime = makeRuntime();
      spin.setRuntime(runtime as any);

      // Register master session (sets user-keyed transport on the A session)
      spin.registerMasterSession({ userId: "aksika", chatId: 111, platform: "telegram", transport: userKeyedTransport });

      const r = await spin.spin({ type: "A", prompt: "hi", userId: "aksika", platform: "telegram", await: true });
      // The session used by spin() must have kept the user-keyed transport
      const usedSession = spin.getSessionById(r.sessionId)!;
      expect(usedSession.transport).toBe(userKeyedTransport);
      // runtime.session() should NOT have been called (no agent-keyed transport created)
      expect(runtime.session).not.toHaveBeenCalled();
    });
  });

  describe("kanban card lifecycle", () => {
    it("goal creates a card; prompt-only does not", async () => {
      spin.setRuntime(makeRuntime() as any);
      const withGoal = await spin.spin({ type: "T", goal: "do something", userId: "aksika", platform: "telegram", source: "user", await: true });
      const noGoal = await spin.spin({ type: "S", prompt: "background", await: true });
      expect(withGoal.cardId).toBeDefined();
      expect(noGoal.cardId).toBeUndefined();
    });

    it("releases the T slot when caller terminalizes before a late execution rejection", async () => {
      let rejectSend: ((error: Error) => void) | undefined;
      const runtime = makeRuntime();
      const transport = mockTransport();
      runtime.openExecution = vi.fn().mockResolvedValue({
        send: () => new Promise<string>((_resolve, reject) => { rejectSend = reject; }),
        cancel: async () => { rejectSend?.(new Error("execution cancelled")); },
        close: vi.fn().mockResolvedValue(undefined),
        transport,
        sessionKey: "mock:late",
        executionId: "mock:late-execution",
        ephemeral: true,
        lastUsage: () => null,
      });
      spin.setRuntime(runtime as any);
      const control = spin.executionSupervisor.open({ executionRef: `spin-slot-${Date.now()}`, type: "T" });
      const dispatch = spin.dispatchAwait({
        type: "T",
        goal: "stalled task",
        source: "task",
        settlementOwner: "caller",
        executionControl: control,
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(control.cardId).toBeDefined();
      control.signalCancel("deadline");
      control.markTerminal("timed_out");
      await expect(dispatch).rejects.toThrow("execution cancelled");
      expect(spin.getRunningCount("T")).toBe(0);
    });

    it("does not callback or complete a supervised O-card from the execution turn", async () => {
      const cardId = kanbanEnqueue("supervised project", "peer");
      projectSupervision.set(cardId, { state: "executing" });
      spin.setRuntime(makeRuntime({ completeResponse: "worker finished" }) as any);

      await spin.spin({ type: "O", cardId, prompt: "run project", callbackPeer: "kp", await: true });
      await new Promise(resolve => setTimeout(resolve, 0));

      const card = (await import("./tasks/kanban-board.js") as any)._kanbanGetCardRaw(cardId);
      expect(card.status).not.toBe("done");
      expect(callbackSend).not.toHaveBeenCalled();
    });

    it("fails closed when O-card supervision cannot be read", async () => {
      const cardId = kanbanEnqueue("unreadable project", "peer");
      projectStoreReadFails = true;
      spin.setRuntime(makeRuntime({ completeResponse: "worker finished" }) as any);

      await spin.spin({ type: "O", cardId, prompt: "run project", callbackPeer: "kp", await: true });
      await new Promise(resolve => setTimeout(resolve, 0));

      const card = (await import("./tasks/kanban-board.js") as any)._kanbanGetCardRaw(cardId);
      expect(card.status).not.toBe("done");
      expect(callbackSend).not.toHaveBeenCalled();
    });
  });

  describe("#1599 — worker criteria outcome decides card status", () => {
    function makeEnvelope(criteria: Array<{ status: string }>): any {
      return {
        schema_version: 1,
        attempt: { id: "a_1", ordinal: 1, contract_id: "c_1", contract_digest: "d", executor_kind: "agent", executor_id: "e", started_at: "", finished_at: "" },
        outcome: "completed",
        criteria,
        checks: [],
        artifacts: [],
        worker_report: { summary: "x", claims: [], unresolved_risks: [] },
      };
    }

    beforeEach(() => {
      callbackSend.mockReset();
    });

    it("settles a supervised worker card failed when criteria did not pass", async () => {
      collectAndSettleOutcome.value = {
        settled: true,
        summary: "✗ 2/2 criteria failed",
        envelope: makeEnvelope([{ criterion_id: "c1", status: "failed", evidence_ids: [] }, { criterion_id: "c2", status: "failed", evidence_ids: [] }]),
      };
      const cardId = kanbanEnqueue("worker lane", "peer");
      // #1644: supervised settlement requires the attempt identity the
      // reconciler claim path would have provided.
      const ctrl = { generation: 1, markTerminal: () => {}, requestCancel: () => Promise.resolve("cancelled" as const), setCardId: () => {}, bind: () => {}, cancelled: false, terminal: false, terminalOutcome: undefined } as never;
      spin.setRuntime(makeRuntime({ completeResponse: "worker finished" }) as any);

      await spin.spin({ type: "W", cardId, contractId: "c_1", attemptId: "a_1", executionControl: ctrl, goal: "run lane", callbackPeer: "kp", await: true });
      await new Promise(resolve => setTimeout(resolve, 0));

      const card = (await import("./tasks/kanban-board.js") as any)._kanbanGetCardRaw(cardId);
      expect(card.status).toBe("failed");
      expect(card.status).not.toBe("delivering");
      const cb = callbackSend.mock.calls[0]?.[1] as { payload?: { status?: string } } | undefined;
      expect(cb?.payload?.status).toBe("failed");
    });

    it("settles a supervised worker card done when all criteria pass", async () => {
      collectAndSettleOutcome.value = {
        settled: true,
        summary: "✓ 2/2 criteria passed",
        envelope: makeEnvelope([{ criterion_id: "c1", status: "passed", evidence_ids: ["v1"] }, { criterion_id: "c2", status: "passed", evidence_ids: ["v2"] }]),
      };
      const cardId = kanbanEnqueue("worker lane", "peer");
      const ctrl = { generation: 1, markTerminal: () => {}, requestCancel: () => Promise.resolve("cancelled" as const), setCardId: () => {}, bind: () => {}, cancelled: false, terminal: false, terminalOutcome: undefined } as never;
      spin.setRuntime(makeRuntime({ completeResponse: "worker finished" }) as any);

      await spin.spin({ type: "W", cardId, contractId: "c_1", attemptId: "a_1", executionControl: ctrl, goal: "run lane", await: true });
      await new Promise(resolve => setTimeout(resolve, 0));

      const card = (await import("./tasks/kanban-board.js") as any)._kanbanGetCardRaw(cardId);
      expect(card.status).toBe("done");
    });

    it("leaves unsupervised workers on today's done path", async () => {
      collectAndSettleOutcome.value = { settled: false, summary: "worker output" };
      const cardId = kanbanEnqueue("plain lane", "peer");
      spin.setRuntime(makeRuntime({ completeResponse: "worker finished" }) as any);

      await spin.spin({ type: "W", cardId, goal: "run lane", await: true });
      await new Promise(resolve => setTimeout(resolve, 0));

      const card = (await import("./tasks/kanban-board.js") as any)._kanbanGetCardRaw(cardId);
      expect(card.status).toBe("done");
    });

    it("fails closed when a supervised worker's criteria outcome cannot be read", async () => {
      collectAndSettleOutcome.value = { settled: false, summary: "[conflict] duplicate attempt with different result" };
      const cardId = kanbanEnqueue("unreadable lane", "peer");
      spin.setRuntime(makeRuntime({ completeResponse: "worker finished" }) as any);

      await spin.spin({ type: "W", cardId, contractId: "c_1", goal: "run lane", callbackPeer: "kp", await: true });
      await new Promise(resolve => setTimeout(resolve, 0));

      const card = (await import("./tasks/kanban-board.js") as any)._kanbanGetCardRaw(cardId);
      expect(card.status).not.toBe("done");
      expect(card.status).not.toBe("failed");
      expect(callbackSend).not.toHaveBeenCalled();
    });
  });

  /*
   * #1651: Spin used to replace an empty provider response with the literal
   * string "(no output)". That fabricated content made three downstream guards
   * unreachable — the sleep completion guard (#1611/#1650), the skill bootstrap
   * guard, and the chat empty/no-reply policy — and wrote the placeholder into
   * memory, card summaries and report artifacts (#1474). These cases pin the
   * truthful contract: the provider's own string, plus a classified outcome.
   */
  describe("empty and no-reply outcomes (#1651)", () => {
    it("returns an empty provider response verbatim, never a placeholder", async () => {
      spin.setRuntime(makeRuntime({ sendPromptImpl: async () => "" }) as any);

      const r = await spin.spin({ type: "A", prompt: "hi", userId: "aksika", platform: "telegram", await: true });

      expect(r.result).toBe("");
      expect(r.outcome).toBe("empty");
    });

    it("reports a deliberate [NO_REPLY] as no_reply, not as empty", async () => {
      spin.setRuntime(makeRuntime({ sendPromptImpl: async () => "[NO_REPLY]" }) as any);

      const r = await spin.spin({ type: "A", prompt: "hi", userId: "aksika", platform: "telegram", await: true });

      expect(r.outcome).toBe("no_reply");
    });

    it("#1651 v2: reports a reaction-only turn as reaction, not as text content", async () => {
      spin.setRuntime(makeRuntime({ sendPromptImpl: async () => "[REACT:👋]" }) as any);

      const r = await spin.spin({ type: "A", prompt: "hi", userId: "aksika", platform: "telegram", await: true });

      expect(r.result).toBe("[REACT:👋]");
      expect(r.outcome).toBe("reaction");
    });

    it("#1651 v2: never records a reaction-only turn as an assistant message in memory", async () => {
      const recordMessage = vi.fn();
      spin.setMemory({ recordMessage });
      spin.setRuntime(makeRuntime({ sendPromptImpl: async () => "[REACT:👋]" }) as any);

      await spin.spin({ type: "A", prompt: "hi", userId: "aksika", platform: "telegram", await: true });

      expect(recordMessage).not.toHaveBeenCalled();
    });

    it("#1651 v2: fails an unsupervised card whose turn produced only a reaction, and reports failed to the peer", async () => {
      collectAndSettleOutcome.value = { settled: false, summary: "" };
      const cardId = kanbanEnqueue("reaction lane", "peer");
      spin.setRuntime(makeRuntime({ sendPromptImpl: async () => "[REACT:👋]" }) as any);

      await spin.spin({ type: "W", cardId, goal: "run lane", callbackPeer: "kp", await: true });
      await new Promise(resolve => setTimeout(resolve, 0));

      const card = (await import("./tasks/kanban-board.js") as any)._kanbanGetCardRaw(cardId);
      expect(card.status).toBe("failed");
      expect(callbackSend).toHaveBeenCalledWith("kp", expect.objectContaining({
        payload: expect.objectContaining({ status: "failed", error: "model returned only a reaction" }),
      }));
    });

    it("never records a contentless turn as an assistant message in memory", async () => {
      const recordMessage = vi.fn();
      spin.setMemory({ recordMessage });
      spin.setRuntime(makeRuntime({ sendPromptImpl: async () => "" }) as any);

      await spin.spin({ type: "A", prompt: "hi", userId: "aksika", platform: "telegram", await: true });

      expect(recordMessage).not.toHaveBeenCalled();
    });

    it("still records a normal turn in memory", async () => {
      const recordMessage = vi.fn();
      spin.setMemory({ recordMessage });
      spin.setRuntime(makeRuntime({ sendPromptImpl: async () => "real answer" }) as any);

      await spin.spin({ type: "A", prompt: "hi", userId: "aksika", platform: "telegram", await: true });

      expect(recordMessage).toHaveBeenCalledWith(expect.objectContaining({ role: "assistant", content: "real answer" }));
    });

    it("fails an unsupervised card whose turn produced no content, and reports failed to the peer", async () => {
      collectAndSettleOutcome.value = { settled: false, summary: "" };
      const cardId = kanbanEnqueue("empty lane", "peer");
      spin.setRuntime(makeRuntime({ sendPromptImpl: async () => "" }) as any);

      await spin.spin({ type: "W", cardId, goal: "run lane", callbackPeer: "kp", await: true });
      await new Promise(resolve => setTimeout(resolve, 0));

      const card = (await import("./tasks/kanban-board.js") as any)._kanbanGetCardRaw(cardId);
      expect(card.status).toBe("failed");
      expect(callbackSend).toHaveBeenCalledWith("kp", expect.objectContaining({
        payload: expect.objectContaining({ status: "failed", error: "model returned no output" }),
      }));
    });

    it("exposes the outcome on the step event", async () => {
      spin.setRuntime(makeRuntime({ sendPromptImpl: async () => "" }) as any);
      const events: any[] = [];

      await spin.spin({ type: "S", prompt: "x", await: true, onStepComplete: e => events.push(e) });

      expect(events[0].result).toBe("");
      expect(events[0].outcome).toBe("empty");
    });
  });

  describe("onStepComplete hook", () => {
    it("fires with correct stepIndex on success", async () => {
      spin.setRuntime(makeRuntime({ completeResponse: "ok" }) as any);
      const events: any[] = [];
      const r1 = await spin.spin({ type: "S", prompt: "x", await: true, onStepComplete: e => events.push(e) });
      const r2 = await spin.spin({ type: "S", prompt: "y", await: true, onStepComplete: e => events.push(e) });
      expect(events.length).toBe(2);
      expect(events[0].result).toBe("ok");
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("fires on failure path with error", async () => {
      const runtime = makeRuntime();
      runtime.openExecution = vi.fn(async () => ({
        send: vi.fn(async () => { throw new Error("boom"); }),
        close: vi.fn(),
        transport: mockTransport(),
        sessionKey: "mock:boom",
        ephemeral: true,
        lastUsage: () => null,
      }));
      spin.setRuntime(runtime as any);
      const events: any[] = [];
      await expect(spin.spin({
        type: "S", prompt: "x", await: true,
        onStepComplete: e => events.push(e),
      })).rejects.toThrow("boom");
      expect(events.length).toBe(1);
      expect(events[0].error).toBeInstanceOf(Error);
      expect(events[0].error.message).toBe("boom");
    });
  });

  describe("metadata", () => {
    it("sets session.metadata at transient allocation; ignores on sessionId reuse", async () => {
      const transport = mockTransport();
      // First spin: transient D allocation with metadata → session.metadata set
      spin.setRuntime(makeRuntime() as any);
      const r1 = await spin.spin({
        type: "D",
        prompt: "init",
        userId: "aksika",
        platform: "telegram",
        metadata: { sleepNight: "2026-07-01" },
        await: true,
      });
      // D is external, so it stays in the Map
      const dSession = spin.getSessionById(r1.sessionId)!;
      expect(dSession.metadata).toEqual({ sleepNight: "2026-07-01" });

      // Reuse with new metadata → session.metadata must NOT change
      dSession.transport = transport;
      await spin.spin({ type: "D", sessionId: dSession.id, prompt: "s2", userId: "aksika", platform: "telegram", metadata: { stepName: "shouldBeIgnored" }, await: true });
      expect(dSession.metadata).toEqual({ sleepNight: "2026-07-01" });
    });
  });

  describe("dispatchBackground", () => {
    it("calls spin() and returns result string", async () => {
      spin.setRuntime(makeRuntime({ completeResponse: "summary text" }) as any);
      const result = await spin.dispatchBackground({ prompt: "summarize" });
      expect(result).toBe("summary text");
    });

    it("uses default type S (ephemeral one-shot)", async () => {
      const runtime = makeRuntime({ completeResponse: "ok" });
      spin.setRuntime(runtime as any);
      await spin.dispatchBackground({ prompt: "x" });
      // S = coding agent → openExecution called with agent="coding"
      const call = (runtime.openExecution as any).mock.calls[0];
      expect(call[0]).toBe("coding");
    });

    it("agent override routes to that agent", async () => {
      const runtime = makeRuntime({ completeResponse: "ok" });
      spin.setRuntime(runtime as any);
      await spin.dispatchBackground({ prompt: "compact", agent: "dreamy" });
      const call = (runtime.openExecution as any).mock.calls[0];
      expect(call[0]).toBe("dreamy");
    });

    it.each<[string, string]>([
      ["empty", ""],
      ["no_reply", "[NO_REPLY]"],
      ["reaction", "[REACT:👋]"],
    ])("rejects a %s response instead of returning it as background text", async (_name, raw) => {
      spin.setRuntime(makeRuntime({ sendPromptImpl: async () => raw }) as any);
      await expect(spin.dispatchBackground({ prompt: "compact" })).rejects.toThrow(
        "background spin returned non-text outcome",
      );
    });
  });

  describe("Orc parity (#1271 — highest-risk area)", () => {
    beforeEach(() => {
      orcLockUpdates.length = 0;
      activeOrcCardUpdates.length = 0;
    });

    it("sets setActiveOrcCard before, clears after (success path)", async () => {
      spin.setRuntime(makeRuntime() as any);
      const r = await spin.spin({ type: "O", goal: "plan this", userId: "aksika", platform: "telegram", source: "user", await: true });
      expect(activeOrcCardUpdates).toHaveLength(0);
      expect(r.cardId).toBeDefined();
    });

    it("clears active card on failure path", async () => {
      const transport = mockTransport({
        sendPrompt: vi.fn().mockRejectedValue(new Error("transport died")),
      });
      const runtime = makeRuntime();
      spin.setRuntime(runtime as any);
      // Trigger initial create — this will get a working transport
      const r1 = await spin.spin({ type: "O", goal: "init", userId: "aksika", platform: "telegram", source: "user", await: true });
      // Now make the visible O session's transport throw on next call
      const orcSession = spin.getSessionById(r1.sessionId)!;
      orcSession.transport = transport;

      await expect(spin.spin({ type: "O", goal: "fail", userId: "aksika", platform: "telegram", source: "user", await: true })).rejects.toThrow("transport died");
      // Project authority is no longer held in module-global active-card state.
      expect(activeOrcCardUpdates).toHaveLength(0);
    });

    it("produces decorated prompt in the exact pre-refactor executeOrc order", async () => {
      const transport = mockTransport({
        sendPrompt: vi.fn(async (sessionKey: string, prompt: string) => {
          // Capture prompt and return
          return "ok";
        }),
      });
      spin.setRuntime(makeRuntime() as any);
      // Trigger create so O session has transport
      await spin.spin({ type: "O", goal: "init", userId: "aksika", platform: "telegram", source: "user", await: true });
      // Replace the O session's transport with a captor
      const sessions = spin.listAllSessions();
      const orcSession = sessions.find(s => s.id.includes("_O_"))!;
      orcSession.transport = transport;
      // Send another prompt
      await spin.spin({ type: "O", sessionId: orcSession.id, goal: "do the work", userId: "aksika", platform: "telegram", source: "user", await: true });
      // Check the prompt that was sent
      const lastCall = (transport.sendPrompt as any).mock.calls[0];
      const sentPrompt: string = lastCall[1];
      // Decorator order: [orcContext, soulBundle, orcNotifications, orcChannel]
      // Each decorator PREPENDS, so last in list appears on top. Final order (top→bottom):
      //   [CHANNEL] (empty, skipped)
      //   [notifications] (empty, skipped)
      //   SOUL_BUNDLE
      //   [CONTEXT] block
      //   <goal>
      // Pre-refactor executeOrc produced: CONTEXT + bundle + goal (no channel/notifications because empty)
      // Verify: contains CONTEXT, SOUL_BUNDLE, then "do the work" at the end
      expect(sentPrompt).toContain("[CONTEXT — do not respond to this section]");
      expect(sentPrompt).toContain("SOUL_BUNDLE");
      expect(sentPrompt.endsWith("do the work")).toBe(true);
      // Decorators PREPEND. Order is [orcContext, soulBundle, orcNotifications, orcChannel].
      // So last-applied (channel) appears on top. Final prompt (top → bottom):
      //   (channel/notification blocks — empty here, skipped)
      //   SOUL_BUNDLE
      //   [CONTEXT] block
      //   <goal>
      // SOUL_BUNDLE comes before CONTEXT (later decorator prepended outer).
      expect(sentPrompt.indexOf("SOUL_BUNDLE")).toBeLessThan(sentPrompt.indexOf("[CONTEXT"));
    });
  });

  describe("future-proofing (adding a new SessionType = new row)", () => {
    it("a fake profile row works with no edits to spin()", async () => {
      // Inject a fake type into the profile registry
      const original = (SESSION_PROFILES as any).X;
      (SESSION_PROFILES as any).X = {
        agent: "coding",
        transportMode: "oneshot",
        resolution: "transient",
        terminateAfter: "call",
        decorators: [],
      };
      try {
        spin.setRuntime(makeRuntime({ completeResponse: "fake-type response" }) as any);
        const r = await spin.spin({ type: "X" as any, prompt: "test", await: true });
        expect(r.result).toBe("fake-type response");
        // X is call-terminate: deleted from Map
        expect(spin.getSessionById(r.sessionId)).toBeUndefined();
      } finally {
        if (original === undefined) delete (SESSION_PROFILES as any).X;
        else (SESSION_PROFILES as any).X = original;
      }
    });
  });

  // ── #1274: concurrency-slot leak + sessionId/cap robustness ────────────

  describe("#1274 — concurrency slot always released", () => {
    it("beforePrompt throw releases the slot → same-type dispatch succeeds", async () => {
      const orig = SESSION_PROFILES["T"].beforePrompt;
      (SESSION_PROFILES["T"] as any).beforePrompt = async () => { throw new Error("beforePrompt kaboom"); };
      spin.setRuntime(makeRuntime() as any);
      try {
        await spin.spin({ type: "T", goal: "first", source: "user", await: true });
      } catch { /* expected */ } finally {
        (SESSION_PROFILES["T"] as any).beforePrompt = orig;
      }
      // Slot must be free — a second T dispatch completes
      spin.setRuntime(makeRuntime({ completeResponse: "ok" }) as any);
      const r = await spin.spin({ type: "T", goal: "second", source: "user", await: true });
      expect(r.result).toBe("ok");
    });

    it("decorator throw releases the slot → next spin of same type succeeds", async () => {
      const orig = SESSION_PROFILES["S"].decorators;
      (SESSION_PROFILES["S"] as any).decorators = [async () => { throw new Error("decorator boom"); }];
      spin.setRuntime(makeRuntime() as any);
      let threw = false;
      try {
        await spin.spin({ type: "S", goal: "boom", source: "user", await: true });
      } catch { threw = true; } finally {
        (SESSION_PROFILES["S"] as any).decorators = orig;
      }
      expect(threw).toBe(true);
      const r = await spin.spin({ type: "S", goal: "ok", source: "user", await: true });
      expect(r.sessionId).toBeTruthy();
    });

    it("await:false pre-exec throw → no unhandled rejection", async () => {
      const orig = SESSION_PROFILES["T"].beforePrompt;
      (SESSION_PROFILES["T"] as any).beforePrompt = async () => { throw new Error("hook fail"); };
      spin.setRuntime(makeRuntime() as any);
      let unhandled = false;
      const handler = () => { unhandled = true; };
      process.on("unhandledRejection", handler);
      try {
        spin.dispatch({ type: "T", goal: "bg task", source: "user" });
        await new Promise(r => setTimeout(r, 50));
      } finally {
        (SESSION_PROFILES["T"] as any).beforePrompt = orig;
        process.off("unhandledRejection", handler);
      }
      expect(unhandled).toBe(false);
    });

    it("tick calls drainQueued (no crash when running set is empty)", async () => {
      spin.setRuntime(makeRuntime() as any);
      // tick is the replacement for the stale scanner — must be safe to call at any time
      await expect((spin as any).tick()).resolves.toBeUndefined();
    });

    it("release removes card from running set", async () => {
      spin.setRuntime(makeRuntime() as any);
      // #1540: occupancy lives in the execution supervisor behind the facade.
      const sup = spin.executionSupervisor;
      expect(sup.admit("W", 99999)).toBe(true);
      expect(sup.runningCardIds()).toContain(99999);
      sup.release("W", 99999);
      expect(sup.runningCardIds()).not.toContain(99999);
    });
  });

  describe("#1411 — drainQueued legacy retry path", () => {
    beforeEach(() => {
      spin.setRuntime(makeRuntime() as any);
    });

    it("skips card with future next_retry_at", async () => {
      const id = kanbanEnqueue("future", "user");
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const mod = await import("./tasks/kanban-board.js");
      (mod as any)._kanbanSetCardField(id, "next_retry_at", future);
      await (spin as any).tick();
      expect(spin.getRunningCount("W")).toBe(0);
    });

    it("dispatches due card with stored type B, not W", async () => {
      const id = kanbanEnqueue("due-b", "user");
      const mod = await import("./tasks/kanban-board.js");
      (mod as any)._kanbanSetCardField(id, "type", "B");
      (mod as any)._kanbanSetCardField(id, "goal", "test goal");
      const past = new Date(Date.now() - 86_400_000).toISOString();
      (mod as any)._kanbanSetCardField(id, "next_retry_at", past);
      const dispatchSpy = vi.spyOn(spin, "dispatch");
      await (spin as any).tick();
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: id, type: "B", goal: "test goal" }),
      );
    });

    it("skips card with no next_retry_at and dispatches via stored type", async () => {
      const id = kanbanEnqueue("no-retry", "user");
      const mod = await import("./tasks/kanban-board.js");
      (mod as any)._kanbanSetCardField(id, "type", "C");
      const dispatchSpy = vi.spyOn(spin, "dispatch");
      await (spin as any).tick();
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ cardId: id, type: "C" }),
      );
    });
  });

  describe("#1274 — sessionId reuse rejects ended sessions", () => {
    it("spin({ sessionId }) on an ended session throws, sendPrompt never called", async () => {
      const transport = mockTransport();
      const runtime = makeRuntime();
      spin.setRuntime(runtime as any);
      const r1 = await spin.spin({ type: "D", prompt: "step1", userId: "aksika", platform: "telegram", await: true });
      const s = spin.getSessionById(r1.sessionId)!;
      s.transport = transport;
      s.status = "ended";
      await expect(
        spin.spin({ type: "D", sessionId: r1.sessionId, prompt: "step2", await: true }),
      ).rejects.toThrow(/is ended/);
      expect(transport.sendPrompt).not.toHaveBeenCalled();
    });
  });

  describe("#1540 — one active execution generation per session", () => {
    it("a second executionControl bound to a busy session is rejected with a typed failure", async () => {
      const runtime = makeRuntime({ completeResponse: "first run ok" });
      spin.setRuntime(runtime as any);

      // Allocate a reusable session (D is persistent/external).
      const first = await spin.spin({ type: "D", prompt: "step1", await: true });
      const sessionId = first.sessionId;

      // A non-terminal control is already bound to that session (simulating
      // an in-flight supervised generation that has not settled yet).
      const busy = spin.executionSupervisor.open({ executionRef: "gen-1", type: "T" });
      const session = spin.getSessionById(sessionId)!;
      session.executionControl = busy;
      expect(spin.executionSupervisor.bindSession("gen-1", sessionId)).toBe(true);

      // A second generation for the same session must not silently overwrite.
      const second = spin.executionSupervisor.open({ executionRef: "gen-2", type: "T" });
      expect(spin.executionSupervisor.bindSession("gen-2", sessionId)).toBe(false);
      await expect(
        spin.spin({
          type: "D",
          sessionId,
          prompt: "step2",
          await: true,
          executionControl: second,
        }),
      ).rejects.toMatchObject({ code: "execution_bind_rejected" });
      await expect(
        spin.spin({
          type: "D",
          sessionId,
          prompt: "step3",
          await: true,
          executionControl: second,
        }),
      ).rejects.toThrow(/already has an active execution/);

      // The session keeps the original control; the stale generation never ran.
      expect(session.executionControl).toBe(busy);
      expect(second.terminal).toBe(false);

      // A terminal old handle frees the session for the next generation.
      busy.markTerminal("completed");
      expect(spin.executionSupervisor.bindSession("gen-2", sessionId)).toBe(true);
    });
  });

  describe("#1274 — session cap gate at dispatch/dispatchAwait layer", () => {
    const MAX = parseInt(process.env["MAX_TOTAL_SESSIONS"] ?? "12", 10);

    // #1540: the registry hides the backing map; fill the cap through the
    // facade so the gate observes the same live-session count as production.
    function fillSessions(s: Spin, count: number): void {
      for (let i = 0; i < count; i++) {
        const r = s.createSubSession("aksika", "telegram", "S");
        if (typeof r === "string") throw new Error(`fillSessions: ${r}`);
      }
    }

    it("dispatch() at cap returns queued cardId without invoking spin()/runtime", async () => {
      const runtime = makeRuntime();
      spin.setRuntime(runtime as any);
      fillSessions(spin, MAX);
      const result = spin.dispatch({ type: "W", goal: "overflow", source: "user" });
      expect(result.cardId).toBeGreaterThan(0);
      await new Promise(r => setTimeout(r, 30));
      expect(runtime.complete).not.toHaveBeenCalled();
      expect(runtime.session).not.toHaveBeenCalled();
    });

    it("dispatchAwait() at cap throws System busy", async () => {
      spin.setRuntime(makeRuntime() as any);
      fillSessions(spin, MAX);
      await expect(
        spin.dispatchAwait({ type: "W", goal: "overflow", source: "user" }),
      ).rejects.toThrow(/System busy/);
    });
  });
});

// ── #1629 trusted tool-authorization provenance ─────────────────────────

describe("spin() — #1629 tool authorization provenance", () => {
  let spin1629: Spin;

  beforeEach(() => {
    spin1629 = new Spin();
    resolveRootImpl = null;
    setUserRegistryOverride(makeRegistry([makeUser("aksika", "master", 111)]));
  });

  function captureRuntime() {
    const contexts: Array<any> = [];
    const runtime = makeRuntime({
      sendPromptImpl: async (_key: string, _prompt: string, _image?: { mime: string; base64: string }, ctx?: any) => {
        contexts.push(ctx);
        return "ok";
      },
    });
    spin1629.setRuntime(runtime as any);
    return contexts;
  }

  it("task-sourced root card → unattended-task on the prompt context", async () => {
    const contexts = captureRuntime();
    const cardId = kanbanEnqueue("scheduled direct task", "task");
    const r = await spin1629.spin({ type: "T", cardId, prompt: "run it", source: "task", await: true, userId: "aksika", platform: "background" });
    expect(r.result).toBe("ok");
    expect(contexts[0]?.authorizationMode).toBe("unattended-task");
  });

  it("agent-sourced Worker child under a task-sourced project root → unattended-task", async () => {
    const contexts = captureRuntime();
    resolveRootImpl = walkToRoot;
    const rootId = kanbanEnqueue("daily-ai project", "task");
    const workerId = kanbanEnqueue("lane 3", "agent");
    _cards.get(workerId)!.parent_id = rootId;
    const r = await spin1629.spin({ type: "W", cardId: workerId, prompt: "run lane", await: true, userId: "aksika", platform: "background" });
    expect(r.result).toBe("ok");
    expect(contexts[0]?.authorizationMode).toBe("unattended-task");
  });

  it("user/agent-sourced roots → interactive", async () => {
    const contexts = captureRuntime();
    const agentCard = kanbanEnqueue("manual agent work", "agent");
    await spin1629.spin({ type: "T", cardId: agentCard, prompt: "run", await: true, userId: "aksika", platform: "background" });
    const userCard = kanbanEnqueue("manual user work", "user");
    await spin1629.spin({ type: "T", cardId: userCard, prompt: "run", await: true, userId: "aksika", platform: "background" });
    expect(contexts[0]?.authorizationMode).toBe("interactive");
    expect(contexts[1]?.authorizationMode).toBe("interactive");
  });

  it("no card (prompt-only spin) → interactive", async () => {
    const contexts = captureRuntime();
    await spin1629.spin({ type: "S", prompt: "one-shot", await: true, userId: "aksika", platform: "background" });
    expect(contexts[0]?.authorizationMode).toBe("interactive");
  });

  it("missing root card → interactive (fails closed)", async () => {
    const contexts = captureRuntime();
    const cardId = kanbanEnqueue("ghost card", "task");
    _cards.delete(cardId); // root unreadable
    await spin1629.spin({ type: "T", cardId, prompt: "run", await: true, userId: "aksika", platform: "background" });
    expect(contexts[0]?.authorizationMode).toBe("interactive");
  });

  it("unreadable/cyclic ancestry → interactive (fails closed)", async () => {
    const contexts = captureRuntime();
    resolveRootImpl = () => undefined;
    const cardId = kanbanEnqueue("cyclic card", "task");
    await spin1629.spin({ type: "T", cardId, prompt: "run", await: true, userId: "aksika", platform: "background" });
    expect(contexts[0]?.authorizationMode).toBe("interactive");
  });

  it("provenance resolver failure → interactive (fails closed)", async () => {
    const contexts = captureRuntime();
    resolveRootImpl = () => { throw new Error("kanban read failed"); };
    const cardId = kanbanEnqueue("unreadable card", "task");
    await spin1629.spin({ type: "T", cardId, prompt: "run", await: true, userId: "aksika", platform: "background" });
    expect(contexts[0]?.authorizationMode).toBe("interactive");
  });

  it("unknown root source → interactive", async () => {
    const contexts = captureRuntime();
    const cardId = kanbanEnqueue("peer work", "peer");
    await spin1629.spin({ type: "T", cardId, prompt: "run", await: true, userId: "aksika", platform: "background" });
    expect(contexts[0]?.authorizationMode).toBe("interactive");
  });

  it("a reused session recomputes the mode from the current card, never retaining the prior value", async () => {
    const contexts = captureRuntime();
    const first = await spin1629.spin({ type: "D", goal: "step one", source: "task", await: true, userId: "aksika", platform: "background" });
    expect(contexts[0]?.authorizationMode).toBe("unattended-task");
    const second = await spin1629.spin({ type: "D", sessionId: first.sessionId, goal: "step two", source: "user", await: true, userId: "aksika", platform: "background" });
    expect(second.sessionId).toBe(first.sessionId); // same reused session
    expect(contexts[1]?.authorizationMode).toBe("interactive");
  });
});

// ── #1338 live attached-session output mirroring ───────────────────────

import { SessionOutputFeed, type SessionOutputEvent } from "./session-output-feed.js";

class RecordingFeed extends SessionOutputFeed {
  events: SessionOutputEvent[] = [];
  publish(e: SessionOutputEvent): void {
    this.events.push(e);
    super.publish(e);
  }
}

describe("spin() — #1338 output mirroring", () => {
  it("threads a call-local observer to the feed for a persistent session", async () => {
    const feed = new RecordingFeed();
    const runtime = makeRuntime({
      sendPromptImpl: async (_key: string, _prompt: string, _image?: { mime: string; base64: string }, ctx?: any) => {
        expect(ctx?.outputObserver).toBeDefined();
        ctx.outputObserver.onDelta({ kind: "text", text: "Hi from model" });
        ctx.outputObserver.onDelta({ kind: "thinking", text: "secret thought" }); // must be excluded
        ctx.outputObserver.onToolStart({ name: "search" });
        return "Hi from model";
      },
    });
    const spin2 = new Spin();
    setUserRegistryOverride(makeRegistry([makeUser("aksika", "master", 111)]));
    spin2.setRuntime(runtime as any);
    spin2.setSessionOutputFeed(feed);
    const r = await spin2.spin({ type: "A", prompt: "hi", await: true, userId: "aksika", platform: "telegram", source: "user" });

    const types = feed.events.map((e) => e.type);
    expect(types).toContain("start");
    expect(types).toContain("delta");
    expect(types).toContain("tool-start");
    expect(types).toContain("end");

    const delta = feed.events.find((e) => e.type === "delta") as Extract<SessionOutputEvent, { type: "delta" }>;
    expect(delta.text).toBe("Hi from model");
    // #1619: thinking enters the feed typed (the TUI renders it natively).
    const thinking = feed.events.find((e) => e.type === "delta" && (e as any).kind === "thinking") as Extract<SessionOutputEvent, { type: "delta" }> | undefined;
    expect(thinking?.text).toBe("secret thought");
    // end is terminal-complete for the same stream
    const end = feed.events.find((e) => e.type === "end") as Extract<SessionOutputEvent, { type: "end" }>;
    expect(end.reason).toBe("complete");
    // every event is tagged with the executed session
    expect(feed.events.every((e) => e.sessionId === r.sessionId)).toBe(true);
  });

  it("threads the observer through the oneshot runtime.complete path", async () => {
    const feed = new RecordingFeed();
    const runtime = makeRuntime({
      sendPromptImpl: async (_key: string, _p: string, _img?: any, ctx?: any) => {
        expect(ctx?.outputObserver).toBeDefined();
        ctx.outputObserver.onDelta({ kind: "text", text: "one-shot text" });
        return "one-shot text";
      },
    });
    const spin2 = new Spin();
    setUserRegistryOverride(makeRegistry([makeUser("aksika", "master", 111)]));
    spin2.setRuntime(runtime as any);
    spin2.setSessionOutputFeed(feed);
    await spin2.spin({ type: "S", prompt: "x", await: true, userId: "aksika", platform: "telegram" });

    const delta = feed.events.find((e) => e.type === "delta") as Extract<SessionOutputEvent, { type: "delta" }>;
    expect(delta?.text).toBe("one-shot text");
  });

  it("does not publish when no output feed is wired", async () => {
    const runtime = makeRuntime({ sendPromptImpl: async () => "ok" });
    const spin2 = new Spin();
    setUserRegistryOverride(makeRegistry([makeUser("aksika", "master", 111)]));
    spin2.setRuntime(runtime as any);
    // No setSessionOutputFeed — must not throw and must still return the result.
    const r = await spin2.spin({ type: "A", prompt: "hi", await: true, userId: "aksika", platform: "telegram", source: "user" });
    expect(r.result).toBe("ok");
  });
});
