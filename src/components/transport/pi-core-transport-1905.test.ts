/**
 * pi-core-transport-1905.test.ts — #1905: no cross-turn failure state at the
 * persistent transport boundary.
 *
 * Two sequential sendPrompt calls on the same transport each reach Pi;
 * a rejected overlapping call disturbs nothing.
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

const CANDIDATE: ModelCandidate = {
  model: "test-model",
  provider: "test-provider",
  endpoint: "https://api.test/v1",
  maxContext: 128000,
  apiKey: "test-key",
  source: "primary",
};

function makeTransport(harness: ReturnType<typeof makeAgentSessionHarness>): PiCoreTransport {
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "system",
    candidate: { ...CANDIDATE },
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    sessionFactoryLoader: harness.loader,
  });
}

describe("PiCoreTransport prompt-local state (#1905, #1940)", () => {
  it("an empty first turn does not affect the second turn: both reach Pi", async () => {
    const harness = makeAgentSessionHarness();
    const transport = makeTransport(harness);
    await transport.initialize();

    const first = transport.sendPrompt("session", "first");
    settleAgentTurn(await waitForPrompt(harness), {});
    await expect(first).resolves.toBe("");

    // No shared exclusion state exists — the next prompt on the same
    // transport reaches Pi unconditionally and delivers.
    const second = transport.sendPrompt("session", "second");
    const session = await waitForPrompt(harness);
    settleAgentTurn(session, { text: "recovered output" });
    await expect(second).resolves.toBe("recovered output");
    expect(session.prompted).toEqual(["first", "second"]);
  });

  it("a rejected overlapping call does not disturb the active call", async () => {
    const harness = makeAgentSessionHarness();
    const transport = makeTransport(harness);
    await transport.initialize();

    const first = transport.sendPrompt("session_1", "hello");
    const session = await waitForPrompt(harness);

    await expect(transport.sendPrompt("session_2", "second")).rejects.toThrow(/already active/);

    settleAgentTurn(session, { text: "late output" });
    await expect(first).resolves.toBe("late output");
    expect((transport as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });
});
