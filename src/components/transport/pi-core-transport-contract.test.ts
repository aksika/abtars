/**
 * pi-core-transport-contract.test.ts — #1622: a Pi execution whose prompt
 * resolves without a terminal agent_end must reject at the transport surface
 * as a typed PiCoreContractError and clear the active host/slot — never as a
 * successful empty answer. The Pi core loader and host are mocked so the
 * contract outcome is deterministic.
 */
import { describe, expect, it, vi } from "vitest";

const mockCreatePiStreamFn = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("./pi-stream-fn.js", () => ({ createPiStreamFn: mockCreatePiStreamFn }));

const { FakeHost } = vi.hoisted(() => {
  class FakeHost {
    isSettled = false;
    state = "created";
    ready = Promise.resolve();
    lastUsage = null;

    constructor(_options: unknown) {}

    async start(): Promise<void> {
      this.state = "running";
    }

    async waitForSettlement(): Promise<"prompt_completed_without_agent_end"> {
      this.state = "settled";
      this.isSettled = true;
      return "prompt_completed_without_agent_end";
    }

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
    createCurrentTurnMessage: (message: string) => ({ role: "abtars_current_turn", content: message }),
    loadAndValidatePiAgentCore: vi.fn().mockResolvedValue({
      module: {},
      installation: { executable: "/usr/bin/pi", packageRoot: "/usr/lib/pi", version: "0.83.0", source: "path", pinStatus: "at-pin", moduleRoots: { ai: "", tui: "", agentCore: "" } },
    }),
  };
});

import { PiCoreTransport } from "./pi-core-transport.js";
import { PiCoreContractError } from "./pi-core-types.js";
import { ModelHealthRegistry } from "./model-health-registry.js";
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
    candidates: makeCandidates(),
    healthRegistry: new ModelHealthRegistry(),
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
  });
}

describe("PiCoreTransport — #1622 prompt completion without agent_end", () => {
  it("rejects with a typed PiCoreContractError and clears active host and slot", async () => {
    const t = makeTransport();
    await t.initialize();

    let caught: unknown;
    try {
      await t.sendPrompt("session_1", "hello");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PiCoreContractError);
    expect((caught as PiCoreContractError).missingCapability).toBe("agent_end settlement");
    expect((caught as Error).message).toMatch(/prompt completed without agent_end/);
    // The rejection unwound the ownership chain: no active host or slot left.
    expect((t as unknown as { activeHost: unknown }).activeHost).toBeNull();
    expect((t as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });
});
