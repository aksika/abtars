/**
 * pi-core-transport-safety.test.ts — #1595: the safety terminal cause leads.
 *
 * With maxPromptRounds 0 the SDK transform's round gate stops the turn; the
 * fake store settles it empty (production behavior) and the transport
 * surfaces the terminal diagnostic instead of prior assistant text.
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

// #1573: initialize() gates readiness on the runtime contract probe; unrelated
// safety tests receive a successful probe.
vi.mock("./pi-runtime-contract.js", () => ({
  validatePiRuntimeContract: vi.fn(async () => {}),
}));

import { PiCoreTransport } from "./pi-core-transport.js";
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
    candidate: candidate,
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    maxPromptRounds: 0,
  });
}

describe("PiCoreTransport terminal safety precedence (#1595)", () => {
  beforeEach(() => {
    FakeSdkConversationStore.resetAll();
  });

  it("reports the safety terminal cause instead of returning prior assistant text", async () => {
    const transport = makeTransport();
    await transport.initialize();
    // The transform stops at the round bound and records the incident; the
    // fake settles the turn empty and the tail leads with the terminal cause.
    FakeSdkConversationStore.queueTurn("session", { text: "partial tool call" });

    await expect(transport.sendPrompt("session", "continue")).rejects.toMatchObject({
      diagnostic: expect.objectContaining({
        reason: "prompt_round_limit",
        safety_incident: "prompt_round_limit",
      }),
    });
  });
});
