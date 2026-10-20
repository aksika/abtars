/**
 * pi-core-transport-safety.test.ts — #1595: the safety terminal cause leads.
 *
 * With maxPromptRounds 0 the safety controller stops the turn; the session
 * settles empty and the transport surfaces the terminal diagnostic instead
 * of a successful empty answer.
 */
import { describe, expect, it, vi } from "vitest";
import {
  makeAgentSessionHarness,
} from "../../test-support/fake-agent-session.js";

vi.mock("./pi-runtime-contract.js", () => ({
  validatePiRuntimeContract: vi.fn(async () => {}),
}));

import { PiCoreTransport } from "./pi-core-transport.js";
import type { ModelCandidate } from "./model-candidates.js";

function makeTransport(harness: ReturnType<typeof makeAgentSessionHarness>): PiCoreTransport {
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
    candidate,
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    sessionFactoryLoader: harness.loader,
    maxPromptRounds: 0,
  });
}

describe("PiCoreTransport terminal safety precedence (#1595)", () => {
  it("reports the safety terminal cause instead of returning assistant text", async () => {
    const harness = makeAgentSessionHarness();
    const transport = makeTransport(harness);
    await transport.initialize();

    // maxPromptRounds 0 trips the round bound before any provider work;
    // the turn fails closed with the terminal diagnostic even though Pi
    // would have delivered text.
    const err = await transport.sendPrompt("session", "continue").catch((e: unknown) => e);
    expect(err).toMatchObject({
      diagnostic: expect.objectContaining({
        reason: "prompt_round_limit",
        safety_incident: "prompt_round_limit",
      }),
    });
    expect((transport as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });
});
