/**
 * pi-agent-session-store.test.ts — #1940 AgentSession store contract.
 *
 * The Pi factory is a fake: no installation, no provider. Every assertion
 * targets the store's own wiring — constrained loader options, in-memory
 * managers, exact tool allowlist, per-turn authority resolution, lifecycle
 * order, and session isolation.
 */

import { describe, it, expect, vi } from "vitest";
import {
  PiAgentSessionStore,
  isUsablePiAgentSessionFactory,
} from "./pi-agent-session-store.js";
import type { PiAgentSessionLike } from "./pi-agent-session-store.js";
import { buildPolicy } from "../tool-sandbox.js";
import { createPiExecutionSafetyController } from "./pi-core-safety.js";
import type { PiCoreToolContext } from "./pi-core-tools.js";
import { ProviderExecutionError } from "./provider-failure.js";

interface FakeSession extends PiAgentSessionLike {
  emit(event: { type: string } & Record<string, unknown>): void;
  setStreaming(value: boolean): void;
  calls: string[];
  prompted: string[];
}

function makeFakeSession(toolNames: string[] = []): FakeSession {
  const listeners = new Set<(event: { type: string } & Record<string, unknown>) => void>();
  const calls: string[] = [];
  const prompted: string[] = [];
  let streaming = false;
  let activeToolNames = [...toolNames];
  const session: FakeSession = {
    calls,
    prompted,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    async prompt(text: string): Promise<void> {
      calls.push("prompt");
      prompted.push(text);
      streaming = true;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async abort(): Promise<void> {
      calls.push("abort");
      streaming = false;
    },
    clearQueue(): unknown {
      calls.push("clearQueue");
      return {};
    },
    async waitForIdle(): Promise<void> {
      calls.push("waitForIdle");
    },
    dispose(): void {
      calls.push("dispose");
    },
    steer(): void {
      calls.push("steer");
    },
    followUp(): void {
      calls.push("followUp");
    },
    async setModel(): Promise<void> {
      calls.push("setModel");
    },
    setThinkingLevel(): void {
      calls.push("setThinkingLevel");
    },
    async compact(): Promise<unknown> {
      calls.push("compact");
      return { summary: "compacted" };
    },
    setStreaming: (value: boolean) => {
      streaming = value;
    },
    getActiveToolNames: () => activeToolNames,
    setActiveToolsByName: (names: string[]) => {
      calls.push("setActiveToolsByName");
      activeToolNames = [...names];
    },
    get isStreaming(): boolean {
      return streaming;
    },
    set isStreaming(value: boolean) {
      streaming = value;
    },
  };
  return session;
}

function makeContext(
  executionId: string,
  overrides: Partial<PiCoreToolContext> = {},
): PiCoreToolContext {
  return {
    executionId,
    userId: "u1",
    sandboxPolicy: buildPolicy("owner", { allowedTools: ["memory_recall"] }),
    safety: createPiExecutionSafetyController(),
    ...overrides,
  };
}

describe("isUsablePiAgentSessionFactory", () => {
  it("accepts the full factory surface and rejects partial shapes", () => {
    const full = {
      createAgentSession: vi.fn(),
      SessionManager: { inMemory: vi.fn() },
      SettingsManager: { inMemory: vi.fn() },
      ModelRuntime: { create: vi.fn() },
      DefaultResourceLoader: class {},
    };
    expect(isUsablePiAgentSessionFactory(full)).toBe(true);
    expect(isUsablePiAgentSessionFactory(null)).toBe(false);
    expect(isUsablePiAgentSessionFactory({})).toBe(false);
    const { SessionManager: _dropped, ...withoutManagers } = full as Record<string, unknown>;
    expect(isUsablePiAgentSessionFactory(withoutManagers)).toBe(false);
  });
});

describe("PiAgentSessionStore (#1940)", () => {
  it("opens with a constrained loader, in-memory managers, and the exact authorized tool allowlist", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const seenLoaderOptions: Array<Record<string, unknown>> = [];
    const sessions: FakeSession[] = [];
    class RecordingLoader {
      constructor(public options: Record<string, unknown>) {
        seenLoaderOptions.push(options);
      }
      async reload(): Promise<void> {}
    }
    const factory = {
      createAgentSession: vi.fn(async (options: Record<string, unknown>) => {
        seen.push(options);
        const toolNames = options.tools as string[];
        const session = makeFakeSession(toolNames);
        sessions.push(session);
        return { session };
      }),
      SessionManager: { inMemory: vi.fn((cwd?: string) => ({ kind: "in-memory", cwd })) },
      SettingsManager: { inMemory: vi.fn(() => ({ kind: "settings-in-memory" })) },
      ModelRuntime: {
        create: vi.fn(async () => ({
          getModel: vi.fn(() => ({ id: "m1" })),
          registerProvider: vi.fn(),
        })),
      },
      DefaultResourceLoader: RecordingLoader,
    };
    const store = new PiAgentSessionStore({ loadFactory: async () => factory });
    const session = await store.ensureSession("telegram:1", {
      systemPrompt: "ROLE-SYSTEM-PROMPT",
      candidate: {
        model: "m1",
        provider: "openai",
        endpoint: "https://api.test/v1",
        maxContext: 128000,
        source: "primary",
      },
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["memory_recall"] }),
      sessionType: "A",
    });
    expect(session).toBe(sessions[0]);
    expect(factory.SessionManager.inMemory).toHaveBeenCalled();
    expect(factory.SettingsManager.inMemory).toHaveBeenCalled();
    expect(factory.ModelRuntime.create).toHaveBeenCalledWith(
      expect.objectContaining({ refreshOnCreate: false, allowModelNetwork: false }),
    );
    const loaderOptions = seenLoaderOptions[0] as Record<string, unknown>;
    expect(loaderOptions.systemPrompt).toBe("ROLE-SYSTEM-PROMPT");
    expect(loaderOptions.noExtensions).toBe(true);
    expect(loaderOptions.noSkills).toBe(true);
    expect(loaderOptions.noPromptTemplates).toBe(true);
    expect(loaderOptions.noThemes).toBe(true);
    expect(loaderOptions.noContextFiles).toBe(true);
    const createOptions = seen[0]!;
    expect(createOptions.tools).toContain("memory_recall");
    expect(createOptions.noTools).toBe("all");
    expect((createOptions.customTools as Array<{ name: string }>).map((t) => t.name)).toEqual(createOptions.tools);
    expect(session.getActiveToolNames()).toEqual(createOptions.tools);
  });

  it("resolves the turn on agent_settled with text, usage, and tool counts", async () => {
    const factory = {
      createAgentSession: vi.fn(async () => ({ session: makeFakeSession(["memory_recall"]) })),
      SessionManager: { inMemory: vi.fn(() => ({})) },
      SettingsManager: { inMemory: vi.fn(() => ({})) },
      ModelRuntime: {
        create: vi.fn(async () => ({
          getModel: vi.fn(() => ({ id: "m1" })),
          registerProvider: vi.fn(),
        })),
      },
      DefaultResourceLoader: class {
        constructor(_options: Record<string, unknown>) {}
        async reload(): Promise<void> {}
      },
    };
    const store = new PiAgentSessionStore({ loadFactory: async () => factory });
    await store.ensureSession("k1", {
      systemPrompt: "sys",
      candidate: { model: "m1", provider: "openai", endpoint: "https://x", maxContext: 1000, source: "primary" },
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["memory_recall"] }),
    });
    const pending = store.prompt("k1", "hello", { executionId: "e1", toolContext: makeContext("e1") });
    const live = (store as unknown as { live: Map<string, { session: FakeSession }> }).live.get("k1")!;
    live.session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stream" } });
    live.session.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final answer" }],
        usage: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2, totalTokens: 100 },
      },
    });
    live.session.emit({ type: "tool_execution_end", isError: false });
    live.session.emit({ type: "agent_end", messages: [], willRetry: false });
    live.session.emit({ type: "agent_settled", aborted: false });
    const result = await pending;
    expect(result.text).toBe("final answer");
    expect(result.aborted).toBe(false);
    expect(result.toolCallsSucceeded).toBe(1);
    expect(result.usage).toEqual({ input: 10, output: 20, cacheRead: 1, cacheWrite: 2 });
    expect(result.contextTokens).toBe(100);
  });

  it("resolves tool authority per turn from the current holder, not the first turn", async () => {
    const seenExecutions: string[] = [];
    const factory = {
      createAgentSession: vi.fn(async (options: Record<string, unknown>) => {
        const customTools = options.customTools as Array<{
          name: string;
          execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
        }>;
        const session = makeFakeSession(customTools.map((t) => t.name));
        const recall = customTools.find((t) => t.name === "memory_recall")!;
        void recall.execute("call-1", {}, undefined).catch(() => undefined);
        return { session };
      }),
      SessionManager: { inMemory: vi.fn(() => ({})) },
      SettingsManager: { inMemory: vi.fn(() => ({})) },
      ModelRuntime: {
        create: vi.fn(async () => ({
          getModel: vi.fn(() => ({ id: "m1" })),
          registerProvider: vi.fn(),
        })),
      },
      DefaultResourceLoader: class {
        constructor(_options: Record<string, unknown>) {}
        async reload(): Promise<void> {}
      },
    };
    void seenExecutions;
    const store = new PiAgentSessionStore({ loadFactory: async () => factory });
    await store.ensureSession("k1", {
      systemPrompt: "sys",
      candidate: { model: "m1", provider: "openai", endpoint: "https://x", maxContext: 1000, source: "primary" },
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["memory_recall"] }),
    });
    // The open-time tool call above ran with no live turn authority, so it
    // fails closed instead of capturing anything.
    const live = (store as unknown as { live: Map<string, { authority: { current: unknown } }> }).live.get("k1")!;
    expect(live.authority.current).toBeNull();
  });

  it("registers an inline model when Pi's catalog does not know the role model", async () => {
    const registered: Array<Record<string, unknown>> = [];
    const knownModels = new Map<string, unknown>();
    const factory = {
      createAgentSession: vi.fn(async (options: Record<string, unknown>) => {
        const model = options.model as { id?: string } | undefined;
        expect(model?.id).toBe("fixture-model-a");
        return { session: makeFakeSession([]) };
      }),
      SessionManager: { inMemory: vi.fn(() => ({})) },
      SettingsManager: { inMemory: vi.fn(() => ({})) },
      ModelRuntime: {
        create: vi.fn(async () => ({
          getModel: vi.fn((providerId: string, modelId: string) => knownModels.get(`${providerId}/${modelId}`)),
          registerProvider: vi.fn((providerId: string, config: Record<string, unknown>) => {
            registered.push({ providerId, ...config });
            for (const m of (config.models as Array<{ id: string }> | undefined) ?? []) {
              knownModels.set(`${providerId}/${m.id}`, { id: m.id });
            }
          }),
        })),
      },
      DefaultResourceLoader: class {
        constructor(_options: Record<string, unknown>) {}
        async reload(): Promise<void> {}
      },
    };
    const store = new PiAgentSessionStore({ loadFactory: async () => factory });
    await store.ensureSession("k1", {
      systemPrompt: "sys",
      candidate: { model: "fixture-model-a", provider: "fixture", endpoint: "https://fixture.local/v1", maxContext: 128000, source: "primary" },
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["*"] }),
    });
    expect(registered.length).toBeGreaterThanOrEqual(1);
    const withModels = registered.find((r) => Array.isArray(r.models));
    expect(withModels).toBeDefined();
    expect((withModels!.models as Array<{ id: string }>)[0]!.id).toBe("fixture-model-a");
  });

  it("activates exactly the per-turn authorized tools (sandbox + availability)", async () => {
    const factory = {
      createAgentSession: vi.fn(async () => ({ session: makeFakeSession([]) })),
      SessionManager: { inMemory: vi.fn(() => ({})) },
      SettingsManager: { inMemory: vi.fn(() => ({})) },
      ModelRuntime: {
        create: vi.fn(async () => ({
          getModel: vi.fn(() => ({ id: "m1" })),
          registerProvider: vi.fn(),
        })),
      },
      DefaultResourceLoader: class {
        constructor(_options: Record<string, unknown>) {}
        async reload(): Promise<void> {}
      },
    };
    const store = new PiAgentSessionStore({ loadFactory: async () => factory });
    await store.ensureSession("k1", {
      systemPrompt: "sys",
      candidate: { model: "m1", provider: "openai", endpoint: "https://x", maxContext: 1000, source: "primary" },
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["*"] }),
    });
    const live = (store as unknown as { live: Map<string, { session: FakeSession }> }).live.get("k1")!;

    // Unattended scheduled execution: delivery is settlement-owned, so the
    // model must not even see send_document.
    const unattended = store.prompt("k1", "scheduled", {
      executionId: "e1",
      toolContext: makeContext("e1", {
        sandboxPolicy: buildPolicy("owner", { allowedTools: ["*"] }),
        authorizationMode: "unattended-task",
      }),
    });
    const scheduledTools = live.session.getActiveToolNames();
    expect(scheduledTools).toContain("memory_recall");
    expect(scheduledTools).not.toContain("send_document");
    live.session.emit({ type: "agent_settled", aborted: false });
    live.session.setStreaming(false);
    await unattended;

    // Operator turn: the full authorized surface returns.
    const operator = store.prompt("k1", "operator", {
      executionId: "e2",
      toolContext: makeContext("e2", {
        sandboxPolicy: buildPolicy("owner", { allowedTools: ["*"] }),
        authorizationMode: "interactive",
      }),
    });
    expect(live.session.getActiveToolNames()).toContain("send_document");
    live.session.emit({ type: "agent_settled", aborted: false });
    live.session.setStreaming(false);
    await operator;
  });

  it("surfaces Pi's terminal provider error instead of a silent empty answer", async () => {
    const factory = {
      createAgentSession: vi.fn(async () => ({ session: makeFakeSession([]) })),
      SessionManager: { inMemory: vi.fn(() => ({})) },
      SettingsManager: { inMemory: vi.fn(() => ({})) },
      ModelRuntime: {
        create: vi.fn(async () => ({
          getModel: vi.fn(() => ({ id: "m1" })),
          registerProvider: vi.fn(),
        })),
      },
      DefaultResourceLoader: class {
        constructor(_options: Record<string, unknown>) {}
        async reload(): Promise<void> {}
      },
    };
    const store = new PiAgentSessionStore({ loadFactory: async () => factory });
    await store.ensureSession("k1", {
      systemPrompt: "sys",
      candidate: { model: "m1", provider: "openai", endpoint: "https://x", maxContext: 1000, source: "primary" },
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["*"] }),
    });
    const pending = store.prompt("k1", "hi", { executionId: "e1", toolContext: makeContext("e1") });
    const live = (store as unknown as { live: Map<string, { session: FakeSession }> }).live.get("k1")!;
    live.session.emit({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "500 fixture blowup" }],
    });
    live.session.emit({ type: "agent_settled", aborted: false });
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderExecutionError);
    expect((err as ProviderExecutionError).failure.code).toBe("all_candidates_failed");
    expect((err as Error).message).toContain("candidate failed");
    expect((err as Error).message).toContain("500 fixture blowup");
  });

  it("a successful final attempt clears an earlier retry failure even without text", async () => {
    const factory = {
      createAgentSession: vi.fn(async () => ({ session: makeFakeSession([]) })),
      SessionManager: { inMemory: vi.fn(() => ({})) },
      SettingsManager: { inMemory: vi.fn(() => ({})) },
      ModelRuntime: {
        create: vi.fn(async () => ({
          getModel: vi.fn(() => ({ id: "m1" })),
          registerProvider: vi.fn(),
        })),
      },
      DefaultResourceLoader: class {
        constructor(_options: Record<string, unknown>) {}
        async reload(): Promise<void> {}
      },
    };
    const store = new PiAgentSessionStore({ loadFactory: async () => factory });
    await store.ensureSession("k1", {
      systemPrompt: "sys",
      candidate: { model: "m1", provider: "openai", endpoint: "https://x", maxContext: 1000, source: "primary" },
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["*"] }),
    });
    const pending = store.prompt("k1", "hi", { executionId: "e1", toolContext: makeContext("e1") });
    const live = (store as unknown as { live: Map<string, { session: FakeSession }> }).live.get("k1")!;
    // Intermediate failed attempt (Pi will retry).
    live.session.emit({
      type: "agent_end",
      willRetry: true,
      messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "503 transient" }],
    });
    // Final attempt succeeded but produced no text (e.g. tool-only turn).
    live.session.emit({
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "assistant", content: [], stopReason: "error", errorMessage: "503 transient" },
        { role: "assistant", content: [], stopReason: "stop" },
      ],
    });
    live.session.emit({ type: "agent_settled", aborted: false });
    await expect(pending).resolves.toMatchObject({ text: "", aborted: false });
  });

  it("committed text wins over a recorded terminal error", async () => {
    const factory = {
      createAgentSession: vi.fn(async () => ({ session: makeFakeSession([]) })),
      SessionManager: { inMemory: vi.fn(() => ({})) },
      SettingsManager: { inMemory: vi.fn(() => ({})) },
      ModelRuntime: {
        create: vi.fn(async () => ({
          getModel: vi.fn(() => ({ id: "m1" })),
          registerProvider: vi.fn(),
        })),
      },
      DefaultResourceLoader: class {
        constructor(_options: Record<string, unknown>) {}
        async reload(): Promise<void> {}
      },
    };
    const store = new PiAgentSessionStore({ loadFactory: async () => factory });
    await store.ensureSession("k1", {
      systemPrompt: "sys",
      candidate: { model: "m1", provider: "openai", endpoint: "https://x", maxContext: 1000, source: "primary" },
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["*"] }),
    });
    const pending = store.prompt("k1", "hi", { executionId: "e1", toolContext: makeContext("e1") });
    const live = (store as unknown as { live: Map<string, { session: FakeSession }> }).live.get("k1")!;
    live.session.emit({
      type: "agent_end",
      willRetry: true,
      messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "transient" }],
    });
    live.session.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "recovered" }], usage: { input: 1, output: 1 } },
    });
    live.session.emit({ type: "agent_settled", aborted: false });
    await expect(pending).resolves.toMatchObject({ text: "recovered" });
  });

  it("disposes with clearQueue/abort/waitForIdle/dispose and releases the session", async () => {
    const factory = {
      createAgentSession: vi.fn(async () => ({ session: makeFakeSession([]) })),
      SessionManager: { inMemory: vi.fn(() => ({})) },
      SettingsManager: { inMemory: vi.fn(() => ({})) },
      ModelRuntime: {
        create: vi.fn(async () => ({
          getModel: vi.fn(() => ({ id: "m1" })),
          registerProvider: vi.fn(),
        })),
      },
      DefaultResourceLoader: class {
        constructor(_options: Record<string, unknown>) {}
        async reload(): Promise<void> {}
      },
    };
    const store = new PiAgentSessionStore({ loadFactory: async () => factory });
    await store.ensureSession("k1", {
      systemPrompt: "sys",
      candidate: { model: "m1", provider: "openai", endpoint: "https://x", maxContext: 1000, source: "primary" },
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["*"] }),
    });
    expect(store.hasLive("k1")).toBe(true);
    await store.disposeSession("k1");
    expect(store.hasLive("k1")).toBe(false);
    const live = (store as unknown as { live: Map<string, { session: FakeSession }> }).live;
    expect(live.has("k1")).toBe(false);
    await expect(
      store.prompt("k1", "late", { executionId: "e9", toolContext: makeContext("e9") }),
    ).rejects.toThrow("no live AgentSession");
  });

  it("keeps two sessions isolated: no shared authority, tools, or events", async () => {
    const seenLoaderOptions: Array<Record<string, unknown>> = [];
    class RecordingLoader {
      constructor(public options: Record<string, unknown>) {
        seenLoaderOptions.push(options);
      }
      async reload(): Promise<void> {}
    }
    const factory = {
      createAgentSession: vi.fn(async (options: Record<string, unknown>) => {
        return { session: makeFakeSession([]) };
      }),
      SessionManager: { inMemory: vi.fn((cwd?: string) => ({ cwd })) },
      SettingsManager: { inMemory: vi.fn(() => ({})) },
      ModelRuntime: {
        create: vi.fn(async () => ({
          getModel: vi.fn(() => ({ id: "m1" })),
          registerProvider: vi.fn(),
        })),
      },
      DefaultResourceLoader: RecordingLoader,
    };
    const store = new PiAgentSessionStore({ loadFactory: async () => factory });
    await store.ensureSession("main", {
      systemPrompt: "MAIN-BUNDLE",
      candidate: { model: "m1", provider: "openai", endpoint: "https://x", maxContext: 1000, source: "primary" },
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["*"] }),
    });
    await store.ensureSession("worker", {
      systemPrompt: "WORKER-BUNDLE",
      candidate: { model: "m1", provider: "openai", endpoint: "https://x", maxContext: 1000, source: "primary" },
      sandboxPolicy: buildPolicy("owner", { allowedTools: ["*"] }),
    });
    expect(factory.createAgentSession).toHaveBeenCalledTimes(2);
    expect(seenLoaderOptions[0]?.systemPrompt).toBe("MAIN-BUNDLE");
    expect(seenLoaderOptions[1]?.systemPrompt).toBe("WORKER-BUNDLE");
    await store.disposeSession("main");
    expect(store.hasLive("main")).toBe(false);
    expect(store.hasLive("worker")).toBe(true);
  });

  function simpleFactory(sessions: FakeSession[], runtime?: { getModel: (...args: string[]) => unknown; registerProvider: (...args: unknown[]) => void }) {
    return {
      createAgentSession: vi.fn(async () => {
        const session = makeFakeSession(["memory_recall"]);
        sessions.push(session);
        return { session };
      }),
      SessionManager: { inMemory: vi.fn(() => ({})) },
      SettingsManager: { inMemory: vi.fn(() => ({})) },
      ModelRuntime: {
        create: vi.fn(async () => runtime ?? ({ getModel: vi.fn(() => ({ id: "m1" })), registerProvider: vi.fn() })),
      },
      DefaultResourceLoader: class {
        constructor(_options: Record<string, unknown>) {}
        async reload(): Promise<void> {}
      },
    };
  }
  const init = {
    systemPrompt: "sys",
    candidate: { model: "m1", provider: "openai", endpoint: "https://x", maxContext: 1000, source: "primary" as const },
    sandboxPolicy: buildPolicy("owner", { allowedTools: ["memory_recall"] }),
  };

  it("#1680: every provider request of a run counts against the prompt-round bound", async () => {
    const sessions: FakeSession[] = [];
    const store = new PiAgentSessionStore({ loadFactory: async () => simpleFactory(sessions) });
    await store.ensureSession("k1", init);
    const safety = createPiExecutionSafetyController({ maxPromptRounds: 2 });
    const pending = store.prompt("k1", "go", { executionId: "e1", toolContext: makeContext("e1", { safety }) });
    const session = sessions[0]!;
    session.emit({ type: "turn_start" }); // first request: admitted by prompt()
    session.emit({ type: "turn_start" }); // tool continuation: round 2
    expect(session.calls).not.toContain("abort");
    session.emit({ type: "turn_start" }); // round 3 exceeds the bound
    expect(session.calls).toContain("abort");
    expect(safety.terminalSafetyFailure).toBe(true);
    session.emit({ type: "agent_settled", aborted: true });
    await pending;
  });

  it("late events from a disposed session never reach its successor", async () => {
    const sessions: FakeSession[] = [];
    const store = new PiAgentSessionStore({ loadFactory: async () => simpleFactory(sessions) });
    await store.ensureSession("k1", init);
    await store.disposeSession("k1");
    await store.ensureSession("k1", init);
    const pending = store.prompt("k1", "hello", { executionId: "e2", toolContext: makeContext("e2") });
    sessions[0]!.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stale" }] } });
    sessions[0]!.emit({ type: "agent_settled", aborted: false });
    sessions[1]!.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fresh" }] } });
    sessions[1]!.emit({ type: "agent_settled", aborted: false });
    expect((await pending).text).toBe("fresh");
  });

  it("abortTurn signals without waiting for Pi to go idle", async () => {
    const sessions: FakeSession[] = [];
    const store = new PiAgentSessionStore({ loadFactory: async () => simpleFactory(sessions) });
    await store.ensureSession("k1", init);
    sessions[0]!.abort = () => new Promise<void>(() => { /* wedged provider: never idle */ });
    expect(store.abortTurn("k1")).toBeUndefined();
  });

  it("a Pi-managed model Pi already knows keeps Pi's own provider definition", async () => {
    const registerProvider = vi.fn();
    const sessions: FakeSession[] = [];
    const store = new PiAgentSessionStore({
      loadFactory: async () => simpleFactory(sessions, { getModel: vi.fn(() => ({ id: "m1" })), registerProvider }),
    });
    await store.ensureSession("k1", { ...init, candidate: { ...init.candidate, authSource: "pi" } });
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("refuses to open a session with an empty system prompt", async () => {
    const sessions: FakeSession[] = [];
    const store = new PiAgentSessionStore({ loadFactory: async () => simpleFactory(sessions) });
    await expect(store.ensureSession("k1", { ...init, systemPrompt: "  " })).rejects.toThrow(/No role system prompt/);
    expect(sessions).toHaveLength(0);
  });
});
