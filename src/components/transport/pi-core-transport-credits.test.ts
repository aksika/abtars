/**
 * pi-core-transport-credits.test.ts — #1297: the stream boundary's typed
 * terminal failure (credits_exhausted) becomes a ProviderExecutionError at the
 * transport surface. The Pi stream factory is mocked so the terminal failure
 * fires synchronously; committed output and per-execution isolation are
 * verified against the real settlement precedence chain.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { FakeHost, hostBehavior } = vi.hoisted(() => {
  const hostBehavior: { emitMessageEnd: boolean } = { emitMessageEnd: false };
  class FakeHost {
    isSettled = false;
    state = "created";
    ready = Promise.resolve();
    private readonly options: { onEvent?: (event: unknown) => unknown };

    constructor(options: { onEvent?: (event: unknown) => unknown }) {
      this.options = options;
    }

    async start(): Promise<void> {
      this.state = "running";
      if (hostBehavior.emitMessageEnd) {
        this.options.onEvent?.({ type: "message_end", message: { role: "assistant", content: "committed output" } });
      }
      this.isSettled = true;
      this.state = "settled";
    }

    async waitForSettlement(): Promise<void> {}
    cancel(): void { this.isSettled = true; }
    async steer(): Promise<void> {}
    async followUp(): Promise<void> {}
  }
  return { FakeHost, hostBehavior };
});

const { terminalFailureMode } = vi.hoisted(() => ({
  terminalFailureMode: { fire: true },
}));

vi.mock("./pi-core-host.js", () => ({ PiCoreExecutionHost: FakeHost }));
vi.mock("./pi-core-types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pi-core-types.js")>();
  return {
    ...actual,
    loadAndValidatePiAgentCore: vi.fn().mockResolvedValue({
      module: {},
      installation: { executable: "/usr/bin/pi", packageRoot: "/usr/lib/pi", version: "0.83.0", source: "path", pinStatus: "at-pin", moduleRoots: { ai: "", tui: "", agentCore: "" } },
    }),
  };
});
vi.mock("./pi-stream-fn.js", () => ({
  createPiStreamFn: vi.fn((options: { onTerminalFailure?: (f: unknown) => void }) => {
    if (terminalFailureMode.fire) {
      options.onTerminalFailure?.({
        code: "credits_exhausted",
        retryable: false,
        attemptedCandidates: 2,
        message: "All model candidates are blocked by provider credit exhaustion",
      });
    }
    return vi.fn(() => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "All model candidates failed", usage: {} } };
      },
      result: async () => ({ role: "assistant", content: [], stopReason: "error", errorMessage: "All model candidates failed", usage: {} }),
    }));
  }),
}));

import { PiCoreTransport } from "./pi-core-transport.js";
import { ProviderExecutionError } from "./provider-failure.js";
import { ModelHealthRegistry } from "./model-health-registry.js";
import type { ModelCandidate } from "./model-candidates.js";

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
    candidates: [candidate],
    healthRegistry: new ModelHealthRegistry(),
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
  });
}

describe("PiCoreTransport terminal provider failure (#1297)", () => {
  beforeEach(() => {
    terminalFailureMode.fire = true;
    hostBehavior.emitMessageEnd = false;
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
    hostBehavior.emitMessageEnd = true;
    const transport = makeTransport();
    await transport.initialize();

    const text = await transport.sendPrompt("session", "continue");
    expect(text).toBe("committed output");
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
