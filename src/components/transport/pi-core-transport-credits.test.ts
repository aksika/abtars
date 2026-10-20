/**
 * pi-core-transport-credits.test.ts — #1297: the stream boundary's typed
 * terminal failure (credits_exhausted) becomes a ProviderExecutionError at the
 * transport surface. The Pi stream factory is mocked so the terminal failure
 * fires synchronously; committed output and per-execution isolation are
 * verified against the real settlement precedence chain.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  FakeSdkAgent,
  FakeSdkConversationStore,
} from "../../test-support/fake-sdk-conversation.js";

const { terminalFailureMode } = vi.hoisted(() => ({
  terminalFailureMode: { fire: true },
}));

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
  // The stream is never consumed (the fake store resolves turns); only the
  // onTerminalFailure side effect matters, fired synchronously at factory
  // creation like the production boundary does after a failed attempt.
  createPiStreamFn: vi.fn(
    (
      options: import("./pi-stream-fn.js").AbtarsPiStreamFnOptions,
    ): import("./pi-core-types.js").StreamFn => {
      if (terminalFailureMode.fire) {
        options.onTerminalFailure?.({
          code: "credits_exhausted",
          retryable: false,
          attemptedCandidates: 2,
          message: "All model candidates are blocked by provider credit exhaustion",
        });
      }
      return (() => {
        throw new Error("fake store never invokes the stream function");
      }) as unknown as import("./pi-core-types.js").StreamFn;
    },
  ),
}));

// #1573: initialize() gates readiness on the runtime contract probe; unrelated
// credit tests receive a successful probe.
vi.mock("./pi-runtime-contract.js", () => ({
  validatePiRuntimeContract: vi.fn(async () => {}),
}));

import { PiCoreTransport } from "./pi-core-transport.js";
import { ProviderExecutionError } from "./provider-failure.js";
import type { ModelCandidate } from "./model-candidates.js";
import { createPiStreamFn } from "./pi-stream-fn.js";

function makeTransport(): PiCoreTransport {
  const candidate: ModelCandidate = {
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://api.test/v1",
    maxContext: 128000,
    apiKey: "test-key",
    source: "primary",
  };
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "system",
    candidate: candidate,
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
  });
}

describe("PiCoreTransport terminal provider failure (#1297)", () => {
  beforeEach(() => {
    FakeSdkConversationStore.resetAll();
    terminalFailureMode.fire = true;
  });

  it("throws ProviderExecutionError carrying the typed failure when no committed output supersedes it", async () => {
    const transport = makeTransport();
    await transport.initialize();

    const err = await transport.sendPrompt("session", "continue").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderExecutionError);
    expect((err as ProviderExecutionError).failure).toMatchObject({
      code: "credits_exhausted",
      retryable: false,
      attemptedCandidates: 2,
    });
  });

  it("returns committed successful output, never overridden by the captured terminal failure", async () => {
    FakeSdkConversationStore.queueTurn("session", { text: "committed output" });
    const transport = makeTransport();
    await transport.initialize();

    const text = await transport.sendPrompt("session", "continue");
    expect(text).toBe("committed output");
  });

  it("throws ProviderExecutionError carrying context_overflow when the stream boundary reports it (#1745)", async () => {
    const transport = makeTransport();
    await transport.initialize();
    vi.mocked(createPiStreamFn).mockImplementationOnce((options) => {
      options.onTerminalFailure?.({
        code: "context_overflow",
        retryable: false,
        attemptedCandidates: 2,
        message: "The request exceeds the context window of every configured model",
      });
      return (() => {
        throw new Error("fake store never invokes the stream function");
      }) as never;
    });

    const err = await transport.sendPrompt("session", "continue").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderExecutionError);
    expect((err as ProviderExecutionError).failure).toMatchObject({
      code: "context_overflow",
      retryable: false,
      attemptedCandidates: 2,
    });
  });

  it("does not leak terminal-failure state into the next execution", async () => {
    const transport = makeTransport();
    await transport.initialize();
    // Execution 1 captures a terminal credit failure.
    await expect(transport.sendPrompt("session", "continue")).rejects.toBeInstanceOf(ProviderExecutionError);
    // Execution 2 has no terminal failure — it must settle generically, not
    // replay the previous execution's credits_exhausted.
    terminalFailureMode.fire = false;
    const text = await transport.sendPrompt("session", "continue");
    expect(text).toBe("");
  });
});
