/**
 * pi-core-transport-1905.test.ts — #1905: no cross-turn failure state at the
 * persistent transport boundary.
 *
 * A stream-function test alone cannot prove the absence of shared exclusion
 * state, so these tests drive two sequential sendPrompt calls on the same
 * transport with a mocked stream factory and host, mirroring
 * pi-core-transport-credits.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { FakeHost, hostBehavior, hostGate } = vi.hoisted(() => {
  const hostBehavior: { emitMessageEnd: boolean } = { emitMessageEnd: false };
  const hostGate: { wait: Promise<void> | null } = { wait: null };
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
      if (hostGate.wait) await hostGate.wait;
      if (hostBehavior.emitMessageEnd) {
        this.options.onEvent?.({ type: "message_end", message: { role: "assistant", content: "recovered output" } });
      }
      this.isSettled = true;
      this.state = "settled";
    }

    async waitForSettlement(): Promise<void> {}
    cancel(): void { this.isSettled = true; }
    async steer(): Promise<void> {}
    async followUp(): Promise<void> {}
  }
  return { FakeHost, hostBehavior, hostGate };
});

vi.mock("./pi-core-host.js", () => ({ PiCoreExecutionHost: FakeHost }));
vi.mock("./pi-core-types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pi-core-types.js")>();
  return {
    ...actual,
    loadAndValidatePiAgentCore: vi.fn().mockResolvedValue({
      module: {},
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
import { ProviderExecutionError, isAllCandidatesFailed } from "./provider-failure.js";
import type { ModelCandidate } from "./model-candidates.js";
import { createPiStreamFn } from "./pi-stream-fn.js";
import type { AbtarsPiStreamFnOptions } from "./pi-stream-fn.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";

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

/** An error stream the FakeHost never consumes; only the factory side effects matter. */
function inertStream(): import("./pi-core-types.js").StreamFn {
  const stream = createAssistantMessageEventStream();
  const terminal: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: "All model candidates failed",
    timestamp: 0,
  };
  stream.push({ type: "error", reason: "error", error: terminal });
  stream.end(terminal);
  return () => stream;
}

describe("PiCoreTransport prompt-local exclusions (#1905)", () => {
  beforeEach(() => {
    hostBehavior.emitMessageEnd = false;
    hostGate.wait = null;
    vi.mocked(createPiStreamFn).mockReset();
    vi.mocked(createPiStreamFn).mockImplementation(() => inertStream());
  });

  it("a failed first turn does not affect the second turn: both reach the provider", async () => {
    const transport = makeTransport();
    await transport.initialize();

    let calls = 0;
    vi.mocked(createPiStreamFn).mockImplementation(() => {
      calls++;
      if (calls === 2) hostBehavior.emitMessageEnd = true;
      return inertStream();
    });

    // First prompt ends with no terminal event and no output: settled empty.
    const first = await transport.sendPrompt("session", "first");
    expect(first).toBe("");
    expect(calls).toBe(1);

    // #1932: no shared exclusion state exists — the next prompt on the same
    // transport reaches the provider unconditionally and delivers.
    const second = await transport.sendPrompt("session", "second");
    expect(second).toBe("recovered output");
    expect(calls).toBe(2);
  });

  it("a rejected overlapping call does not disturb the active call", async () => {
    const transport = makeTransport();
    await transport.initialize();

    let releaseStart!: () => void;
    hostGate.wait = new Promise<void>((resolve) => { releaseStart = resolve; });
    try {
      const first = transport.sendPrompt("session_1", "hello");
      await vi.waitFor(() => expect((transport as unknown as { activeSlot: unknown }).activeSlot).not.toBeNull());

      await expect(transport.sendPrompt("session_2", "second")).rejects.toThrow(/already active/);

      releaseStart();
      await first;
      expect((transport as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
    } finally {
      hostGate.wait = null;
    }
  });

  it("a generic all-candidates failure surfaces as ProviderExecutionError, not a settled empty", async () => {
    const transport = makeTransport();
    await transport.initialize();
    vi.mocked(createPiStreamFn).mockImplementation((options: AbtarsPiStreamFnOptions) => {
      options.onTerminalFailure?.({
        code: "all_candidates_failed",
        retryable: false,
        attemptedCandidates: 0,
        message: "All model candidates failed",
      });
      return inertStream();
    });

    const err = await transport.sendPrompt("session", "continue").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderExecutionError);
    expect(isAllCandidatesFailed(err)).toBe(true);
    expect((err as ProviderExecutionError).failure).toMatchObject({
      code: "all_candidates_failed",
      retryable: false,
      attemptedCandidates: 0,
    });
  });
});
