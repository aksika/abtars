/**
 * pi-core-transport-credits.test.ts — #1940: provider errors propagate raw.
 *
 * Pi owns retry and overflow recovery; abtars never masks provider errors.
 * A provider failure from session.prompt() surfaces unchanged at the
 * transport surface (never wrapped, never a silent empty answer), committed
 * output wins, and a failed turn clears the slot without leaking state.
 */
import { describe, expect, it, vi } from "vitest";
import {
  makeAgentSessionHarness,
  latestSession,
  waitForPrompt,
  settleAgentTurn,
  FakeAgentSession,
} from "../../test-support/fake-agent-session.js";
import type { PiAgentSessionFactoryLoader } from "./pi-agent-session-store.js";

vi.mock("./pi-runtime-contract.js", () => ({
  validatePiRuntimeContract: vi.fn(async () => {}),
}));

import { PiCoreTransport } from "./pi-core-transport.js";
import type { ModelCandidate } from "./model-candidates.js";

function makeCandidate(): ModelCandidate {
  return {
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://api.test/v1",
    maxContext: 128000,
    apiKey: "test-key",
    source: "primary",
  };
}

function makeTransport(loader: PiAgentSessionFactoryLoader): PiCoreTransport {
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "system",
    candidate: makeCandidate(),
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    sessionFactoryLoader: loader,
  });
}

/** Loader whose sessions fail the next prompt with the given error. */
function failingPromptLoader(error: unknown): PiAgentSessionFactoryLoader {
  return (async () => ({
    createAgentSession: vi.fn(async () => {
      const session = new FakeAgentSession();
      session.failNextPrompt = error;
      return { session };
    }),
    SessionManager: { inMemory: vi.fn(() => ({})) },
    SettingsManager: { inMemory: vi.fn(() => ({})) },
    ModelRuntime: {
      create: vi.fn(async () => ({
        getModel: vi.fn(() => ({ id: "m" })),
        registerProvider: vi.fn(),
      })),
    },
    DefaultResourceLoader: class {
      async reload(): Promise<void> {}
    },
  })) as PiAgentSessionFactoryLoader;
}

describe("PiCoreTransport provider errors propagate raw (#1940 R6)", () => {
  it("a provider failure rejects unchanged and clears the slot", async () => {
    const providerError = new Error("provider exploded: 503 upstream");
    const transport = makeTransport(failingPromptLoader(providerError));
    await transport.initialize();

    const err = await transport.sendPrompt("session", "continue").catch((e: unknown) => e);
    expect(err).toBe(providerError);
    expect((transport as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });

  it("returns committed successful output", async () => {
    const harness = makeAgentSessionHarness();
    const transport = makeTransport(harness.loader);
    await transport.initialize();

    const pending = transport.sendPrompt("session", "continue");
    const session = await waitForPrompt(harness);
    settleAgentTurn(session, { text: "committed output" });
    await expect(pending).resolves.toBe("committed output");
  });

  it("an aborted turn clears the slot and the same session serves the next turn", async () => {
    const harness = makeAgentSessionHarness();
    const transport = makeTransport(harness.loader);
    await transport.initialize();

    // Execution 1 aborts (cancel path) and settles empty.
    const first = transport.sendPrompt("session", "continue");
    const firstSession = await waitForPrompt(harness);
    firstSession.emit({ type: "agent_settled", aborted: true });
    firstSession.streaming = false;
    await expect(first).resolves.toBe("");
    expect((transport as unknown as { activeSlot: unknown }).activeSlot).toBeNull();

    // Execution 2 reuses the same live session and settles generically.
    const second = transport.sendPrompt("session", "continue");
    const secondSession = await waitForPrompt(harness);
    expect(secondSession).toBe(firstSession);
    settleAgentTurn(secondSession, {});
    await expect(second).resolves.toBe("");
    expect((transport as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
    expect(latestSession(harness)).toBe(firstSession);
  });
});
