import { describe, expect, it, vi } from "vitest";

const { FakeHost } = vi.hoisted(() => {
  class FakeHost {
    isSettled = false;
    state = "created";
    ready = Promise.resolve();
    private readonly options: { safety: { beginProviderTurn: (key: string) => unknown; }; onEvent?: (event: unknown) => unknown };

    constructor(options: { safety: { beginProviderTurn: (key: string) => unknown }; onEvent?: (event: unknown) => unknown }) {
      this.options = options;
    }

    async start(): Promise<void> {
      this.state = "running";
      // Simulate the last assistant/tool-call text that would otherwise be
      // mistaken for a completed response after the safety controller stops.
      this.options.onEvent?.({ type: "message_end", message: { role: "assistant", content: "partial tool call" } });
      this.options.safety.beginProviderTurn("test-model@https://api.test/v1");
      this.isSettled = true;
      this.state = "settled";
    }

    async waitForSettlement(): Promise<void> {}
    cancel(): void { this.isSettled = true; }
    async steer(): Promise<void> {}
    async followUp(): Promise<void> {}
  }

  return { FakeHost };
});

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

// #1573: initialize() gates readiness on the runtime contract probe; unrelated
// safety tests receive a successful probe.
vi.mock("./pi-runtime-contract.js", () => ({
  validatePiRuntimeContract: vi.fn(async () => {}),
}));

import { PiCoreTransport } from "./pi-core-transport.js";
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
    maxPromptRounds: 0,
  });
}

describe("PiCoreTransport terminal safety precedence (#1595)", () => {
  it("reports the safety terminal cause instead of returning prior assistant text", async () => {
    const transport = makeTransport();
    await transport.initialize();

    await expect(transport.sendPrompt("session", "continue")).rejects.toMatchObject({
      diagnostic: expect.objectContaining({
        reason: "prompt_round_limit",
        safety_incident: "prompt_round_limit",
      }),
    });
  });
});
