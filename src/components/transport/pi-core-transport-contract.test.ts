/**
 * pi-core-transport-contract.test.ts — #1940: AgentSession turn lifecycle.
 *
 * A pre-run session failure rejects at the transport surface and clears
 * the slot — never a successful empty answer. The factory is injected so
 * the contract outcome is deterministic.
 */
import { describe, expect, it, vi } from "vitest";
import {
  makeAgentSessionHarness,
  waitForPrompt,
  settleAgentTurn,
} from "../../test-support/fake-agent-session.js";

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

function makeTransport(harness: ReturnType<typeof makeAgentSessionHarness>): PiCoreTransport {
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "system",
    candidate: makeCandidates()[0]!,
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    sessionFactoryLoader: harness.loader,
  });
}

describe("PiCoreTransport — AgentSession turn lifecycle contract", () => {
  it("a pre-run session failure rejects and clears the slot", async () => {
    const { PiCoreTransport: T2 } = await import("./pi-core-transport.js");
    const failing = new T2({
      role: "main",
      systemPrompt: "system",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      sessionFactoryLoader: (async () => {
        throw new Error("Pi AgentSession factory unavailable");
      }),
    });
    await failing.initialize();
    let caught: unknown;
    try {
      await failing.sendPrompt("session_1", "hello");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/factory unavailable/);
    // The rejection unwound the ownership chain: no active slot left.
    expect((failing as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });

  it("#1691: a second sendPrompt is rejected while the first turn runs; the first settles and clears the slot", async () => {
    const harness = makeAgentSessionHarness();
    const t = makeTransport(harness);
    await t.initialize();

    const first = t.sendPrompt("session_1", "hello");
    const session = await waitForPrompt(harness);

    // A second prompt fails BEFORE it can replace the slot or reset any
    // shared per-call state — the first call keeps exclusive ownership.
    await expect(t.sendPrompt("session_2", "second")).rejects.toThrow(/already active/);
    expect((t as unknown as { activeSlot: unknown }).activeSlot).not.toBeNull();

    // Settling the held turn lets it resolve and clear the slot it owns —
    // nothing of the second call leaked into the shared state.
    settleAgentTurn(session, { text: "late output" });
    await expect(first).resolves.toBe("late output");
    expect((t as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });

  it("#1506: sendInterrupt during a running turn signals abort and returns promptly", async () => {
    const harness = makeAgentSessionHarness();
    const t = new PiCoreTransport({
      role: "main",
      systemPrompt: "system",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      sessionFactoryLoader: harness.loader,
      interruptIdleTimeoutMs: 50,
    });
    await t.initialize();
    const first = t.sendPrompt("session_1", "hello");
    const session = await waitForPrompt(harness);

    // Interrupt never awaits provider acquisition: it signals abort and
    // observes teardown up to its bound, even while the turn runs.
    await t.sendInterrupt("operator stop");
    expect(session.calls).toContain("abort");

    settleAgentTurn(session, { text: "late" });
    await expect(first).resolves.toBe("late");
  });
});
