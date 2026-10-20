/**
 * pi-core-transport-contract.test.ts — #1932: SDK turn lifecycle contract.
 *
 * A pre-run session failure (auth gate, compaction in progress) rejects at
 * the transport surface and clears the slot — never a successful empty
 * answer. The SDK store and Pi core loader are mocked so the contract
 * outcome is deterministic.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  FakeSdkAgent,
  FakeSdkConversationStore,
} from "../../test-support/fake-sdk-conversation.js";

const mockCreatePiStreamFn = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("./pi-stream-fn.js", () => ({ createPiStreamFn: mockCreatePiStreamFn }));
vi.mock("./pi-sdk-conversation.js", () => ({ PiSdkConversationStore: FakeSdkConversationStore }));
vi.mock("./pi-core-types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pi-core-types.js")>();
  return {
    ...actual,
    loadAndValidatePiAgentCore: vi.fn().mockResolvedValue({
      module: { Agent: FakeSdkAgent },
      installation: { executable: "/usr/bin/pi", packageRoot: "/usr/lib/pi", version: "0.85.1", source: "path", pinStatus: "at-pin", moduleRoots: { ai: "", tui: "", agentCore: "" } },
    }),
  };
});

// #1573: initialize() gates readiness on the runtime contract probe; unrelated
// contract tests receive a successful probe.
vi.mock("./pi-runtime-contract.js", () => ({
  validatePiRuntimeContract: vi.fn(async () => {}),
}));

import { PiCoreTransport } from "./pi-core-transport.js";
import type { ModelCandidate } from "./model-candidates.js";

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

function makeTransport(): PiCoreTransport {
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "system",
    candidate: makeCandidates()[0]!,
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
  });
}

describe("PiCoreTransport — SDK turn lifecycle contract", () => {
  beforeEach(() => {
    FakeSdkConversationStore.resetAll();
  });

  it("a pre-run session failure rejects and clears the slot", async () => {
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.queueTurn("session_1", { error: new Error("Authentication failed for \"test-provider\"") });

    let caught: unknown;
    try {
      await t.sendPrompt("session_1", "hello");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Authentication failed/);
    // The rejection unwound the ownership chain: no active slot left.
    expect((t as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });

  it("#1691: a second sendPrompt is rejected while the first turn is held; the first settles and clears the slot", async () => {
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.queueTurn("session_1", { hold: true, text: "late output" });

    const first = t.sendPrompt("session_1", "hello");
    const store = FakeSdkConversationStore.latest();
    if (!store) throw new Error("expected a FakeSdkConversationStore instance");
    await vi.waitFor(() => expect(store.promptCalls).toHaveLength(1));

    // A second prompt fails BEFORE it can replace the slot or reset any
    // shared per-call state — the first call keeps exclusive ownership.
    await expect(t.sendPrompt("session_2", "second")).rejects.toThrow(/already active/);
    expect((t as unknown as { activeSlot: unknown }).activeSlot).not.toBeNull();

    // Releasing the held turn lets it settle and clear the slot it owns —
    // nothing of the second call leaked into the shared state.
    store.releaseHold("session_1");
    await expect(first).resolves.toBe("late output");
    expect((t as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });

  it("#1506: sendInterrupt during a held turn signals cancel and returns promptly", async () => {
    const t = new PiCoreTransport({
      role: "main",
      systemPrompt: "system",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      interruptIdleTimeoutMs: 50,
    });
    await t.initialize();
    FakeSdkConversationStore.queueTurn("session_1", { hold: true, text: "late" });
    const first = t.sendPrompt("session_1", "hello");
    const store = FakeSdkConversationStore.latest();
    if (!store) throw new Error("expected a FakeSdkConversationStore instance");
    await vi.waitFor(() => expect(store.promptCalls).toHaveLength(1));

    // Interrupt never awaits provider acquisition: it signals and observes
    // teardown up to its bound, even while the turn is still held.
    await t.sendInterrupt("operator stop");
    expect(store.cancelledKeys).toContain("session_1");

    store.releaseHold("session_1");
    await expect(first).resolves.toBe("late");
  });
});
