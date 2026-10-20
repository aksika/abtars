/**
 * pi-core-transport-1905.test.ts — #1905: no cross-turn failure state at the
 * persistent transport boundary.
 *
 * A stream-function test alone cannot prove the absence of shared exclusion
 * state, so these tests drive two sequential sendPrompt calls on the same
 * transport with a mocked stream factory and SDK conversation store,
 * mirroring pi-core-transport-credits.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  FakeSdkAgent,
  FakeSdkConversationStore,
} from "../../test-support/fake-sdk-conversation.js";

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
vi.mock("./pi-stream-fn.js", () => ({
  createPiStreamFn: vi.fn(),
}));
vi.mock("./pi-runtime-contract.js", () => ({
  validatePiRuntimeContract: vi.fn(async () => {}),
}));

import { PiCoreTransport } from "./pi-core-transport.js";
import type { ModelCandidate } from "./model-candidates.js";
import { createPiStreamFn } from "./pi-stream-fn.js";

const CANDIDATE: ModelCandidate = {
  model: "test-model",
  provider: "test-provider",
  endpoint: "https://api.test/v1",
  maxContext: 128000,
  apiKey: "test-key",
  source: "primary",
};

function makeTransport(): PiCoreTransport {
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "system",
    candidate: { ...CANDIDATE },
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
  });
}

function fakeStore(): FakeSdkConversationStore {
  const store = FakeSdkConversationStore.latest();
  if (!store) throw new Error("expected a FakeSdkConversationStore instance");
  return store;
}

describe("PiCoreTransport prompt-local exclusions (#1905)", () => {
  beforeEach(() => {
    FakeSdkConversationStore.resetAll();
    vi.mocked(createPiStreamFn).mockReset();
    vi.mocked(createPiStreamFn).mockImplementation((() => {}) as never);
  });

  function script(sessionKey: string, script: { text?: string; hold?: boolean }): void {
    FakeSdkConversationStore.queueTurn(sessionKey, script);
  }

  it("a failed first turn does not affect the second turn: both reach the provider", async () => {
    const transport = makeTransport();
    await transport.initialize();
    script("session", {});
    script("session", { text: "recovered output" });

    // First prompt ends with no output: settled empty.
    const first = await transport.sendPrompt("session", "first");
    expect(first).toBe("");
    const store = fakeStore();
    expect(store.promptCalls).toHaveLength(1);

    // #1932: no shared exclusion state exists — the next prompt on the same
    // transport reaches the provider unconditionally and delivers.
    const second = await transport.sendPrompt("session", "second");
    expect(second).toBe("recovered output");
    expect(store.promptCalls).toHaveLength(2);
    expect(store.promptCalls[1]?.text).toBe("second");
  });

  it("a rejected overlapping call does not disturb the active call", async () => {
    const transport = makeTransport();
    await transport.initialize();
    script("session_1", { hold: true, text: "late output" });

    const first = transport.sendPrompt("session_1", "hello");
    const store = fakeStore();
    await vi.waitFor(() => expect(store.promptCalls).toHaveLength(1));

    await expect(transport.sendPrompt("session_2", "second")).rejects.toThrow(/already active/);

    store.releaseHold("session_1");
    await first;
    expect((transport as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });
});
