// Pi session factory is injected per transport (sessionFactoryLoader), so
// these tests verify the compositor structure and lifecycle with a fake
// factory — deterministically, regardless of host Pi installation.
// Real-Pi integration coverage lives in the Pi production lanes.

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { PiCoreTransport, extractAssistantText } from "./pi-core-transport.js";
import { ensurePiThinkingClamp } from "./pi-ai-adapter.js";
import { DurableContextUnavailableError } from "./pi-core-context.js";
import { convertCurrentTurnToLlm } from "./pi-core-types.js";
import type { AbtarsCurrentTurnMessage } from "./pi-core-types.js";
import type { ModelCandidate } from "./model-candidates.js";
import type { PiAgentSessionFactoryLoader } from "./pi-agent-session-store.js";

// ── Fake Pi AgentSession factory ─────────────────────────────────────────

interface QueuedTurn {
  text?: string;
  usage?: { input: number; output: number };
  contextTokens?: number | null;
  toolCalls?: number;
  error?: unknown;
}

class FakeAgentSession {
  calls: string[] = [];
  prompted: string[] = [];
  steered: string[] = [];
  followedUp: string[] = [];
  private listeners = new Set<(event: { type: string } & Record<string, unknown>) => void>();
  streaming = false;

  subscribe(listener: (event: { type: string } & Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: { type: string } & Record<string, unknown>): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async prompt(text: string): Promise<void> {
    this.calls.push("prompt");
    this.prompted.push(text);
    this.streaming = true;
    const turn = FakeAgentSessionStore.queued.get(this);
    if (turn?.error) {
      const err = turn.error;
      FakeAgentSessionStore.queued.delete(this);
      this.streaming = false;
      throw err;
    }
  }

  async abort(): Promise<void> {
    this.calls.push("abort");
    this.streaming = false;
  }

  clearQueue(): unknown {
    this.calls.push("clearQueue");
    return {};
  }

  async waitForIdle(): Promise<void> {
    this.calls.push("waitForIdle");
  }

  dispose(): void {
    this.calls.push("dispose");
    this.streaming = false;
  }

  steer(text: string): void {
    this.calls.push("steer");
    this.steered.push(text);
  }

  followUp(text: string): void {
    this.calls.push("followUp");
    this.followedUp.push(text);
  }

  async setModel(): Promise<void> {
    this.calls.push("setModel");
  }

  setThinkingLevel(): void {
    this.calls.push("setThinkingLevel");
  }

  async compact(): Promise<unknown> {
    this.calls.push("compact");
    return { summary: "compacted" };
  }

  getContextUsage(): undefined {
    return undefined;
  }

  getActiveToolNames(): string[] {
    return [];
  }

  get isStreaming(): boolean {
    return this.streaming;
  }
}

/** Per-test fake factory state: created sessions + per-session queued turns. */
class FakeAgentSessionStore {
  static created: Array<Record<string, unknown>> = [];
  static queued = new Map<FakeAgentSession, QueuedTurn>();
  static sessions: FakeAgentSession[] = [];

  static reset(): void {
    FakeAgentSessionStore.created = [];
    FakeAgentSessionStore.queued = new Map();
    FakeAgentSessionStore.sessions = [];
  }

  static sessionForCreateIndex(index: number): FakeAgentSession {
    const session = FakeAgentSessionStore.sessions[index];
    if (!session) throw new Error(`expected created session ${index}`);
    return session;
  }

  /** Settle the latest turn on a session with a queued result. */
  static settle(session: FakeAgentSession, turn: QueuedTurn): void {
    if (turn.text !== undefined) {
      session.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: turn.text }],
          ...(turn.usage !== undefined || turn.contextTokens !== undefined
            ? {
              usage: {
                input: turn.usage?.input ?? 0,
                output: turn.usage?.output ?? 0,
                ...(turn.contextTokens !== undefined && turn.contextTokens !== null
                  ? { totalTokens: turn.contextTokens }
                  : {}),
              },
            }
            : {}),
        },
      });
    }
    for (let i = 0; i < (turn.toolCalls ?? 0); i++) {
      session.emit({ type: "tool_execution_end", isError: false });
    }
    session.emit({ type: "agent_settled", aborted: false });
    session.streaming = false;
  }
}

function makeFactoryLoader(): PiAgentSessionFactoryLoader & { factory: Record<string, unknown> } {
  const factory = {
    createAgentSession: vi.fn(async (options: Record<string, unknown>) => {
      FakeAgentSessionStore.created.push(options);
      const session = new FakeAgentSession();
      FakeAgentSessionStore.sessions.push(session);
      return { session };
    }),
    SessionManager: { inMemory: vi.fn(() => ({ kind: "in-memory" })) },
    SettingsManager: { inMemory: vi.fn(() => ({})) },
    ModelRuntime: {
      create: vi.fn(async () => ({
        getModel: vi.fn((providerId: string, modelId: string) => ({ id: modelId, provider: providerId })),
        registerProvider: vi.fn(),
      })),
    },
    DefaultResourceLoader: class {
      constructor(public options: Record<string, unknown>) {}
      async reload(): Promise<void> {}
    },
  };
  const loader = (async () => factory) as PiAgentSessionFactoryLoader & { factory: Record<string, unknown> };
  loader.factory = factory;
  return loader;
}

// #1573: the readiness probe is the external boundary of initialize(). Unrelated
// tests receive a successful probe; readiness tests override it per case.
vi.mock("./pi-runtime-contract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pi-runtime-contract.js")>();
  return {
    ...actual,
    validatePiRuntimeContract: vi.fn(async () => {}),
  };
});

import { validatePiRuntimeContract, PiRuntimeContractError } from "./pi-runtime-contract.js";

beforeEach(() => {
  FakeAgentSessionStore.reset();
});

function makeCandidates(): ModelCandidate[] {
  return [{
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://api.test/v1",
    maxContext: 128000,
    apiKey: "test-key",
    source: "primary",
  }];
}

function makeTransport() {
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "You are a helpful assistant.",
    candidate: makeCandidates()[0]!,
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    sessionFactoryLoader: makeFactoryLoader(),
  });
}

/** Send a prompt while a queued turn settles it on the next microtask. */
async function sendWithQueuedTurn(
  transport: PiCoreTransport,
  sessionKey: string,
  text: string,
  turn: QueuedTurn,
  context?: Parameters<PiCoreTransport["sendPrompt"]>[3],
): Promise<string> {
  const pending = transport.sendPrompt(sessionKey, text, undefined, context);
  let session: FakeAgentSession | undefined;
  for (let i = 0; i < 1000; i++) {
    session = FakeAgentSessionStore.sessions[FakeAgentSessionStore.sessions.length - 1];
    // The store sets its settle hook synchronously inside session.prompt(),
    // so only settle once the fake observed the prompt — settling earlier
    // would emit into no collector and hang the turn.
    if (session && session.prompted.length > 0 && session.streaming) break;
    session = undefined;
    await Promise.resolve();
  }
  if (!session) throw new Error("fake session never received the prompt");
  FakeAgentSessionStore.settle(session, turn);
  return pending;
}

describe("PiCoreTransport", () => {
  it("constructs with main role", () => {
    const t = makeTransport();
    expect(t.config.role).toBe("main");
    expect(t.config.candidate.model).toBe("test-model");
  });

  it("starts uninitialized", () => {
    const t = makeTransport();
    expect(t.isReady).toBe(false);
  });

  describe("availability memo retired (#1940 R1)", () => {
    it("dispatches without any memo gate — memory is decided once at boot", async () => {
      const transport = makeTransport();
      await transport.initialize();
      const text = await sendWithQueuedTurn(transport, "test-session", "hello", { text: "admitted" });
      expect(text).toBe("admitted");
    });
  });

  it("initialize sets isReady", async () => {
    const t = makeTransport();
    await t.initialize();
    expect(t.isReady).toBe(true);
  });

  describe("readiness contract (#1573)", () => {
    beforeEach(() => {
      vi.mocked(validatePiRuntimeContract).mockReset();
      vi.mocked(validatePiRuntimeContract).mockResolvedValue(undefined);
    });

    it("keeps the transport not-ready and suppresses onReady when the probe fails", async () => {
      const t = makeTransport();
      const onReady = vi.fn();
      t.onReady = onReady;
      vi.mocked(validatePiRuntimeContract).mockRejectedValueOnce(
        new PiRuntimeContractError("Pi runtime contract incompatible (0.84.0; pi-ai; missing createProvider).", {
          component: "pi-ai",
          capability: "createProvider",
        }),
      );
      await expect(t.initialize()).rejects.toThrow(PiRuntimeContractError);
      expect(t.isReady).toBe(false);
      expect(onReady).not.toHaveBeenCalled();
    });

    it("probes again after a rejected attempt and succeeds once repaired", async () => {
      const t = makeTransport();
      const onReady = vi.fn();
      t.onReady = onReady;
      vi.mocked(validatePiRuntimeContract).mockRejectedValueOnce(
        new PiRuntimeContractError("Pi runtime contract incompatible (0.84.0; openai-completions; missing streamSimple).", {
          component: "openai-completions",
          capability: "streamSimple",
        }),
      );
      await expect(t.initialize()).rejects.toThrow(PiRuntimeContractError);
      expect(t.isReady).toBe(false);

      await t.initialize();
      expect(t.isReady).toBe(true);
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it("shares one in-flight probe among concurrent callers", async () => {
      const t = makeTransport();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      vi.mocked(validatePiRuntimeContract).mockImplementationOnce(() => gate);
      const first = t.initialize();
      const second = t.initialize();
      for (let i = 0; i < 100 && vi.mocked(validatePiRuntimeContract).mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(vi.mocked(validatePiRuntimeContract)).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([first, second]);
      expect(vi.mocked(validatePiRuntimeContract)).toHaveBeenCalledTimes(1);
      expect(t.isReady).toBe(true);
    });
  });

  it("implements IKiroTransport interface", () => {
    const t = makeTransport();
    expect(typeof t.initialize).toBe("function");
    expect(typeof t.sendPrompt).toBe("function");
    expect(typeof t.resetSession).toBe("function");
    expect(typeof t.sendInterrupt).toBe("function");
    expect(typeof t.destroy).toBe("function");
    expect(typeof t.lastUsage).toBe("function");
    expect(typeof t.getRuntimeStatus).toBe("function");
  });

  it("getRuntimeStatus returns route/provider/model", () => {
    const t = makeTransport();
    const status = t.getRuntimeStatus();
    expect(status.route).toBe("pi-ai");
    expect(status.provider).toBe("test-provider");
    expect(status.model).toBe("test-model");
  });

  it("resetSession clears state", async () => {
    const t = makeTransport();
    await t.resetSession("test_session");
    expect(t.isReady).toBe(false);
  });

  it("destroy clears active host", () => {
    const t = makeTransport();
    t.destroy();
    expect(t.isReady).toBe(false);
  });

  it("sendPrompt without a session factory fails closed (never silent fallback)", async () => {
    const t = new PiCoreTransport({
      role: "main",
      systemPrompt: "You are a helpful assistant.",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      sessionFactoryLoader: async () => null,
    });
    await t.initialize();
    await expect(t.sendPrompt("test_session", "hello")).rejects.toThrow(/factory unavailable/);
    expect((t as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });

  it("interrupt on inactive host does not throw", async () => {
    const t = makeTransport();
    await t.sendInterrupt();
  });

  it("supports specialist role", () => {
    const t = new PiCoreTransport({
      role: "specialist",
      systemPrompt: "",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      sessionFactoryLoader: makeFactoryLoader(),
    });
    expect(t.config.role).toBe("specialist");
  });

  it("accepts the retired late-bound provider holder option and ignores it (#1940)", () => {
    // Boot still passes contextProvider while callers migrate; the Pi route
    // no longer reads durable context per turn.
    const t = new PiCoreTransport({
      role: "main",
      systemPrompt: "",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      sessionFactoryLoader: makeFactoryLoader(),
      contextProvider: { current: { projectContext: vi.fn() } as never },
    });
    expect(t.config.role).toBe("main");
  });

  it("sendPrompt with no context does not crash — returns text via the session tap", async () => {
    const t = makeTransport();
    await t.initialize();
    const text = await sendWithQueuedTurn(t, "sess_1", "hello", { text: "hello back" });
    expect(text).toBe("hello back");
    expect((t as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });

  it("#1940: the role system prompt is captured once per session with exact tool allowlist", async () => {
    const loader = makeFactoryLoader();
    const t = new PiCoreTransport({
      role: "main",
      systemPrompt: "MAIN-SOUL-BUNDLE",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["memory_recall"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: false },
      sessionFactoryLoader: loader,
    });
    await t.initialize();
    const text = await sendWithQueuedTurn(t, "sess_1", "hi", { text: "ok" });
    expect(text).toBe("ok");
    expect(FakeAgentSessionStore.created).toHaveLength(1);
    const options = FakeAgentSessionStore.created[0]!;
    expect(options.tools).toContain("memory_recall");
    expect(options.noTools).toBe("all");
    expect(loader.factory.SessionManager.inMemory).toHaveBeenCalled();
    expect(loader.factory.SettingsManager.inMemory).toHaveBeenCalled();
    expect(loader.factory.ModelRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({ refreshOnCreate: false, allowModelNetwork: false }),
    );
  });

  it("#1940: two sessions are isolated — one dispose leaves the other live", async () => {
    const t = makeTransport();
    await t.initialize();
    await sendWithQueuedTurn(t, "sess_a", "hi", { text: "a-ok" });
    await sendWithQueuedTurn(t, "sess_b", "hi", { text: "b-ok" });
    expect(FakeAgentSessionStore.created).toHaveLength(2);
    await t.resetSession("sess_a");
    const again = sendWithQueuedTurn(t, "sess_b", "again", { text: "b-again" });
    await expect(again).resolves.toBe("b-again");
    expect(FakeAgentSessionStore.created).toHaveLength(2);
  });

  it("#1940: overlapping sendPrompt is rejected — one writer per session", async () => {
    const t = makeTransport();
    await t.initialize();
    const first = t.sendPrompt("sess_1", "first");
    await expect(t.sendPrompt("sess_1", "second")).rejects.toThrow(/already active/);
    let session: FakeAgentSession | undefined;
    for (let i = 0; i < 1000; i++) {
      session = FakeAgentSessionStore.sessions[FakeAgentSessionStore.sessions.length - 1];
      if (session && session.prompted.length > 0) break;
      session = undefined;
      await Promise.resolve();
    }
    if (!session) throw new Error("fake session never received the prompt");
    FakeAgentSessionStore.settle(session, { text: "first-ok" });
    await expect(first).resolves.toBe("first-ok");
  });

  it("setSystemPrompt updates config", () => {
    const t = makeTransport();
    t.setSystemPrompt("New prompt");
    expect(t.config.systemPrompt).toBe("New prompt");
  });

  it("setModel changes the configured candidate", async () => {
    const t = makeTransport();
    await t.setModel("new-model", "https://new.endpoint/v1", 64000);
    expect(t.config.candidate.model).toBe("new-model");
    expect(t.config.candidate.endpoint).toBe("https://new.endpoint/v1");
    expect(t.config.candidate.maxContext).toBe(64000);
  });

  it("setModel keeps the conversation — applies live without dispose", async () => {
    const t = makeTransport();
    await t.initialize();
    await sendWithQueuedTurn(t, "sess_1", "hi", { text: "ok" });
    await t.setModel("other-model");
    const session = FakeAgentSessionStore.sessionForCreateIndex(0);
    expect(session.calls).toContain("setModel");
    expect(session.calls).not.toContain("dispose");
    expect(FakeAgentSessionStore.created).toHaveLength(1);
  });

  it("setReasoningEffort applies live to open sessions via Pi", async () => {
    const t = makeTransport();
    await t.initialize();
    await sendWithQueuedTurn(t, "sess_1", "hi", { text: "ok" });
    t.setReasoningEffort("high");
    const session = FakeAgentSessionStore.sessionForCreateIndex(0);
    expect(session.calls).toContain("setThinkingLevel");
  });

  it("compactSession delegates to Pi — system prompt survives", async () => {
    const t = makeTransport();
    await t.initialize();
    await sendWithQueuedTurn(t, "sess_1", "hi", { text: "ok" });
    await t.compactSession("sess_1", "focus");
    const session = FakeAgentSessionStore.sessionForCreateIndex(0);
    expect(session.calls).toContain("compact");
  });

  it("image input emits text+image parts in the pi-ai message", () => {
    // The transport's internal image plumbing was previously asserted through
    // sendPrompt with a bare rejection — which observed nothing about images.
    // The pure conversion that carries the image shape into the pi-ai message
    // is asserted directly (#1582).
    const msg: AbtarsCurrentTurnMessage = {
      role: "abtars_current_turn",
      executionId: "exec_1",
      sessionId: "sess_1",
      content: "Look at this",
      timestamp: 123,
      images: [{ type: "image", mimeType: "image/png", data: "iVBOR=" }],
    };
    const m = convertCurrentTurnToLlm(msg);
    expect(m.role).toBe("user");
    if (typeof m.content === "string") throw new Error("expected content parts for an image turn");
    expect(m.content[0]).toMatchObject({ type: "text", text: "Look at this" });
    expect(m.content[1]).toMatchObject({ type: "image", data: "iVBOR=", mimeType: "image/png" });
  });

  it("factory failure clears the slot", async () => {
    const t = new PiCoreTransport({
      role: "main",
      systemPrompt: "You are a helpful assistant.",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      sessionFactoryLoader: async () => null,
    });
    await t.initialize();
    const err = await t.sendPrompt("s", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/factory unavailable/);
    expect((t as unknown as Record<string, unknown>).activeSlot).toBeNull();
  });

  it("rejects required_unavailable intent before any host/provider work (#1529)", async () => {
    const t = makeTransport();
    await t.initialize();
    const promise = t.sendPrompt("sess_1", "hello", undefined, {
      userId: "user-1",
      durableContextIntent: { mode: "required_unavailable", reason: "record_failed" },
    });
    await expect(promise).rejects.toBeInstanceOf(DurableContextUnavailableError);
    // #1932: the preflight propagates the intent's reason instead of
    // masking every pre-provider failure as cursor_unavailable.
    await expect(promise).rejects.toMatchObject({ reason: "record_failed" });
    expect((t as unknown as Record<string, unknown>).activeSlot).toBeNull();
  });

  it("rejects durable intent without caller identity before any host/provider work (#1529)", async () => {
    const t = makeTransport();
    await t.initialize();
    const promise = t.sendPrompt("sess_1", "hello", undefined, {
      durableContextIntent: { mode: "durable", beforeMessageId: 42 },
    });
    await expect(promise).rejects.toBeInstanceOf(DurableContextUnavailableError);
    await expect(promise).rejects.toMatchObject({ reason: "identity_unavailable" });
    expect((t as unknown as Record<string, unknown>).activeSlot).toBeNull();
  });

  it("runs a valid durable intent through Pi without a context provider — history stays Pi-owned (#1940)", async () => {
    const t = makeTransport();
    await t.initialize();
    const text = await sendWithQueuedTurn(t, "sess_1", "hello", { text: "durable ok" }, {
      userId: "user-1",
      durableContextIntent: { mode: "durable", beforeMessageId: 42 },
    });
    expect(text).toBe("durable ok");
  });

  it("lets omitted intent (not-required) past preflight — intentional ephemeral stays operable (#1529)", async () => {
    const t = makeTransport();
    await t.initialize();
    const text = await sendWithQueuedTurn(t, "sess_1", "hello", { text: "ephemeral ok" }, {
      userId: "user-1",
    });
    expect(text).toBe("ephemeral ok");
  });
});

// ── extractAssistantText (pure function) ─────────────────────────────────────

describe("extractAssistantText", () => {
  it("returns string content as-is", () => {
    expect(extractAssistantText("Hello world")).toBe("Hello world");
  });

  it("extracts only text parts from mixed text+toolCall content", () => {
    const content = [
      { type: "text", text: "Here's the answer. " },
      { type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } },
      { type: "text", text: "Done." },
    ];
    expect(extractAssistantText(content)).toBe("Here's the answer. Done.");
  });

  it("returns empty string for toolCall-only content", () => {
    const content = [
      { type: "toolCall", id: "t1", name: "bash", arguments: {} },
    ];
    expect(extractAssistantText(content)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(extractAssistantText([])).toBe("");
  });

  it("returns empty string for non-array, non-string input", () => {
    expect(extractAssistantText({ foo: "bar" })).toBe("");
  });

  it("skips non-text parts gracefully", () => {
    const content = [
      { type: "text", text: "A" },
      { type: "unknown", text: "B" },
      { type: "text", text: "C" },
    ];
    expect(extractAssistantText(content)).toBe("AC");
  });
});


describe("#1619 reasoning effort (session-scoped)", () => {
  // #1746: resolveCandidateModel reads pi's clamp from the runtime slot now.
  // Production populates it at boot and in the contract probe; these tests do
  // the same with pi's real function so the constructor-time clamp is
  // exercised as shipped (the pi-installation mock above is "absent", so the
  // slot is fed the already-loaded module directly).
  beforeAll(async () => {
    await ensurePiThinkingClamp({ clampThinkingLevel });
  });

  it("initializes requested effort from effort-style thinking config; off otherwise", () => {
    const t = makeTransport();
    const status = t.getRuntimeStatus();
    expect(status.reasoning).toBe("off");
    const withConfig = new PiCoreTransport({
      role: "main",
      systemPrompt: "",
      candidate: { ...makeCandidates()[0]!, thinking: { style: "effort", default: "medium" } },
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    });
    expect(withConfig.getRuntimeStatus().reasoning).toBe("medium");
  });

  it("clamps an effort-style configured default before the first turn", () => {
    const withConfig = new PiCoreTransport({
      role: "main",
      systemPrompt: "",
      candidate: { ...makeCandidates()[0]!, thinking: { style: "effort", default: "xhigh" } },
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    });
    expect(withConfig.getRuntimeStatus().reasoning).toBe("high");
    expect(withConfig.getRuntimeStatus().reasoningRequested).toBe("xhigh");
  });

  it("setReasoningEffort stores requested and reports the Pi-clamped effective value", () => {
    const t = makeTransport();
    const state = t.setReasoningEffort("high");
    expect(state).toEqual({ requested: "high", effective: "high" });
  });

  it("clamps xhigh to the custom model's supported maximum (Pi authoritative)", () => {
    const t = makeTransport();
    const state = t.setReasoningEffort("xhigh");
    expect(state.requested).toBe("xhigh");
    expect(state.effective).toBe("high");
  });

  it("off is a real level and disables reasoning", () => {
    const t = makeTransport();
    const state = t.setReasoningEffort("off");
    expect(state.effective).toBe("off");
  });

  it("runtime status publishes effective reasoning and requested when clamped", () => {
    const t = makeTransport();
    t.setReasoningEffort("xhigh");
    const status = t.getRuntimeStatus();
    expect(status.reasoning).toBe("high");
    expect(status.reasoningRequested).toBe("xhigh");
    t.setReasoningEffort("high");
    const aligned = t.getRuntimeStatus();
    expect(aligned.reasoningRequested).toBeUndefined();
  });

  it("resetSession retains requested effort but clears measured context", async () => {
    const t = makeTransport();
    t.setReasoningEffort("high");
    await t.resetSession("s1");
    expect(t.getRuntimeStatus().reasoning).toBe("high");
    expect(t.getRuntimeStatus().contextPercent).toBeUndefined();
  });
});

describe("#1619 context accounting (truthful)", () => {
  it("reports unknown percentage with the configured window before valid usage", () => {
    const t = makeTransport();
    const status = t.getRuntimeStatus();
    expect(status.contextPercent).toBeUndefined();
    expect(status.contextWindow).toBe(128000);
    expect(t.contextPercent).toBe(-1);
  });

  it("invalidateContextUsage clears measured tokens only", () => {
    const t = makeTransport();
    t.invalidateContextUsage();
    const status = t.getRuntimeStatus();
    expect(status.contextPercent).toBeUndefined();
    expect(status.contextWindow).toBe(128000);
  });

  it("computes a display-clamped percentage from tokens and the committed window", () => {
    const t = makeTransport();
    (t as unknown as { currentContextTokens: number | null }).currentContextTokens = 64000;
    (t as unknown as { currentContextWindow: number | null }).currentContextWindow = 128000;
    const status = t.getRuntimeStatus();
    expect(status.contextPercent).toBe(50);
    expect(t.contextPercent).toBe(50);
  });
});

describe("#1619 typed output deltas and semantic segments", () => {
  it("hasToolCallContent detects toolCall blocks only", async () => {
    const { hasToolCallContent } = await import("./pi-core-transport.js");
    expect(hasToolCallContent([{ type: "text", text: "hi" }])).toBe(false);
    expect(hasToolCallContent([{ type: "toolCall", id: "t1", name: "search", arguments: {} }])).toBe(true);
    expect(hasToolCallContent("plain string")).toBe(false);
    expect(hasToolCallContent(null)).toBe(false);
  });
});
