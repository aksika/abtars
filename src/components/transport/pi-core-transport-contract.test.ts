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

const { FakeHost, setSettlementGate } = vi.hoisted(() => {
  /** #1691: deferred settlement latch so a test can hold the first prompt. */
  let settlementGate: Promise<"prompt_completed_without_agent_end"> | null = null;
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
      return settlementGate ?? Promise.resolve("prompt_completed_without_agent_end");
    }

    cancel(): void { this.isSettled = true; }
    async steer(): Promise<void> {}
    async followUp(): Promise<void> {}
  }
  return {
    FakeHost,
    setSettlementGate: (gate: Promise<"prompt_completed_without_agent_end"> | null): void => {
      settlementGate = gate;
    },
  };
});

vi.mock("./pi-core-host.js", () => ({ PiCoreExecutionHost: FakeHost }));
vi.mock("./pi-core-types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pi-core-types.js")>();
  return {
    ...actual,
    createCurrentTurnMessage: (message: string) => ({ role: "abtars_current_turn", content: message }),
    loadAndValidatePiAgentCore: vi.fn().mockResolvedValue({
      module: {},
      installation: { executable: "/usr/bin/pi", packageRoot: "/usr/lib/pi", version: "0.84.2", source: "path", pinStatus: "at-pin", moduleRoots: { ai: "", tui: "", agentCore: "" } },
    }),
  };
});

// #1573: initialize() gates readiness on the runtime contract probe; unrelated
// contract tests receive a successful probe.
vi.mock("./pi-runtime-contract.js", () => ({
  validatePiRuntimeContract: vi.fn(async () => {}),
}));

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

  it("#1691: a second sendPrompt is rejected while the first slot is held; the first settles and clears both fields", async () => {
    const t = makeTransport();
    await t.initialize();

    // Hold the first host's settlement so the first prompt stays active.
    let releaseSettlement!: (reason: "prompt_completed_without_agent_end") => void;
    setSettlementGate(new Promise<"prompt_completed_without_agent_end">((resolve) => {
      releaseSettlement = resolve;
    }));
    try {
      const first = t.sendPrompt("session_1", "hello");
      await vi.waitFor(() => expect((t as unknown as { activeSlot: unknown }).activeSlot).not.toBeNull());
      const firstHost = (t as unknown as { activeHost: unknown }).activeHost;
      expect(firstHost).not.toBeNull();

      // A second prompt fails BEFORE it can replace the slot/host or reset any
      // shared per-call state — the first call keeps exclusive ownership.
      await expect(t.sendPrompt("session_2", "second")).rejects.toThrow(/already active/);
      expect((t as unknown as { activeSlot: unknown }).activeSlot).not.toBeNull();
      expect((t as unknown as { activeHost: unknown }).activeHost).toBe(firstHost);

      // Releasing the first settlement lets it reach its terminal contract
      // error and clear the host/slot it owns — nothing of the second call
      // leaked into the shared state.
      releaseSettlement("prompt_completed_without_agent_end");
      await expect(first).rejects.toBeInstanceOf(PiCoreContractError);
      expect((t as unknown as { activeHost: unknown }).activeHost).toBeNull();
      expect((t as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
    } finally {
      setSettlementGate(null);
    }
  });
});
