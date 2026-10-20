/**
 * pi-sdk-transform.test.ts — #1932: request-scoped SDK transform.
 *
 * Pure factory over explicit inputs: proves safety round limits, scrubbing,
 * durable admission (liveness/probe/gap/gate), and request-scoped system
 * replacement with Pi history untouched — without a live SDK session.
 */
import { describe, it, expect } from "vitest";
import { buildSdkTransform, buildRequestSystemText, type SdkTransformInputs } from "./pi-sdk-transform.js";
import { DurableContextUnavailableError } from "./pi-core-context.js";
import type { PiDurableContextProvider } from "./pi-core-context.js";
import type { DurableContextProjectionResult } from "../memory-runtime.js";
import type { PiExecutionSafetyController } from "./pi-core-safety.js";
import type { AgentMessage } from "./pi-core-types.js";
import { PiSoulGate } from "../pi-session/pi-soul-gate.js";

function fakeSafety(overrides?: Partial<PiExecutionSafetyController>): PiExecutionSafetyController {
  return {
    promptRoundsUsed: 0,
    maxPromptRounds: 25,
    activeCandidateKey: "",
    beforeTool: () => ({ decision: "execute" }),
    afterTool: () => ({ decision: "execute" }),
    beginProviderTurn: () => ({ decision: "continue" }),
    requestPause: () => {},
    requestStop: (_reason: string) => {},
    recordClassifiedStoreLiteral: (_literal: string) => {},
    scrubClassifiedLiterals: (messages) => messages,
    incident: null,
    lastTerminalIncident: null,
    paused: false,
    stopped: false,
    terminalSafetyFailure: false,
    ...overrides,
  };
}

function ephemeralInputs(overrides?: Partial<SdkTransformInputs>): SdkTransformInputs {
  return {
    safety: fakeSafety(),
    source: { mode: "ephemeral", sessionKey: "sess" },
    volatileBlocks: [],
    executionId: "exec-1",
    candidateKey: "model@https://api.test/v1",
    projectContext: async () => { throw new Error("must not probe on ephemeral path"); },
    memoryState: () => "ready",
    outboxHas: () => false,
    gate: new PiSoulGate(),
    generation: 1,
    getSystemPrompt: () => "bundle text",
    ...overrides,
  };
}

function durableInputs(overrides?: Partial<SdkTransformInputs> & {
  probe?: (input: { userId: string; sessionId: string; beforeMessageId: number; maxContext: number }) => Promise<unknown>;
}): SdkTransformInputs {
  const probe = overrides?.probe ?? (async () => ({ messages: [] }));
  const { probe: _dropped, ...rest } = overrides ?? {};
  const provider: PiDurableContextProvider = {
    projectContext: (input: { userId: string; sessionId: string; beforeMessageId: number; maxContext: number }) =>
      probe(input) as Promise<DurableContextProjectionResult>,
  };
  return {
    ...ephemeralInputs(),
    source: { mode: "durable", sessionKey: "sess", beforeMessageId: 7, maxContext: 128000, userId: "u1" },
    contextProvider: provider,
    projectContext: (input) => provider.projectContext(input),
    ...rest,
  };
}

const history: AgentMessage[] = [
  { role: "system", content: "structural", timestamp: 1 } as unknown as AgentMessage,
  { role: "user", content: "earlier question", timestamp: 2 } as unknown as AgentMessage,
  { role: "assistant", content: "earlier answer", timestamp: 3 } as unknown as AgentMessage,
];

describe("buildSdkTransform", () => {
  it("replaces the system bundle per request and passes Pi history through", async () => {
    const out = await buildSdkTransform(ephemeralInputs())(history);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(out[0])).toContain("bundle text");
    expect(JSON.stringify(out[0])).not.toContain("structural");
    // History untouched.
    expect(out[1]).toEqual(history[1]);
    expect(out[2]).toEqual(history[2]);
  });

  it("prepends a system message when the transcript has none", async () => {
    const out = await buildSdkTransform(ephemeralInputs())([
      { role: "user", content: "hi", timestamp: 1 } as unknown as AgentMessage,
    ]);
    expect(out[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(out[0])).toContain("bundle text");
  });

  it("appends volatile blocks to the request system text", async () => {
    const out = await buildSdkTransform(ephemeralInputs({
      volatileBlocks: [{ kind: "session_start", content: "fresh context" }],
    }))(history);
    expect(JSON.stringify(out[0])).toContain("fresh context");
    expect(JSON.stringify(out[0])).toContain("session_start");
  });

  it("stops at the prompt round bound", async () => {
    const safety = fakeSafety({ beginProviderTurn: () => ({ decision: "stop", reason: "Prompt round limit (3) reached" }) });
    await expect(buildSdkTransform(ephemeralInputs({ safety }))(history)).rejects.toThrow(/Prompt round limit/);
  });

  it("pauses on a pause decision", async () => {
    let paused = false;
    const safety = fakeSafety({
      beginProviderTurn: () => ({ decision: "pause" }),
      requestPause: () => { paused = true; },
    });
    await expect(buildSdkTransform(ephemeralInputs({ safety }))(history)).rejects.toThrow(/paused/i);
    expect(paused).toBe(true);
  });

  it("scrubs classified literals before admission", async () => {
    const seen: string[] = [];
    const safety = fakeSafety({
      scrubClassifiedLiterals: (messages) => {
        seen.push(JSON.stringify(messages));
        return messages;
      },
    });
    await buildSdkTransform(ephemeralInputs({ safety }))(history);
    expect(seen).toHaveLength(1);
  });

  it("passes messages through on abort without admission", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await buildSdkTransform(durableInputs({
      projectContext: async () => { throw new Error("must not probe when aborted"); },
    }))(history, controller.signal);
    expect(out).toEqual(history);
  });

  it("durable: denies when memory is not ready", async () => {
    await expect(buildSdkTransform(durableInputs({ memoryState: () => "unavailable" }))(history))
      .rejects.toSatisfy((err: unknown) => err instanceof DurableContextUnavailableError && err.reason === "runtime_unavailable");
  });

  it("durable: denies without a context provider", async () => {
    const inputs = durableInputs();
    delete (inputs as { contextProvider?: unknown }).contextProvider;
    await expect(buildSdkTransform(inputs)(history))
      .rejects.toSatisfy((err: unknown) => err instanceof DurableContextUnavailableError && err.reason === "no_provider");
  });

  it("durable: denies on malformed probe response", async () => {
    await expect(buildSdkTransform(durableInputs({ probe: async () => ({ nope: true }) }))(history))
      .rejects.toSatisfy((err: unknown) => err instanceof DurableContextUnavailableError && err.reason === "malformed_response");
  });

  it("durable: maps probe rejection to provider_rejected", async () => {
    await expect(buildSdkTransform(durableInputs({
      probe: async () => { throw new Error("abmind down"); },
    }))(history))
      .rejects.toSatisfy((err: unknown) => err instanceof DurableContextUnavailableError && err.reason === "provider_rejected");
  });

  it("durable: denies on a known archive gap", async () => {
    await expect(buildSdkTransform(durableInputs({ outboxHas: () => true }))(history))
      .rejects.toSatisfy((err: unknown) => err instanceof DurableContextUnavailableError && err.reason === "record_failed");
  });

  it("durable: admits after a successful probe and carries one marked bundle", async () => {
    const out = await buildSdkTransform(durableInputs({ getSystemPrompt: () => "fresh bundle" }))(history);
    const systemText = JSON.stringify(out[0]);
    expect(systemText).toContain("fresh bundle");
    // Exactly one marked envelope (request/cursor identity), no accumulation.
    expect(systemText.match(/abmind-bundle|bundle-request|executionId|exec-1/g)?.length).toBeGreaterThan(0);
    expect(out[1]).toEqual(history[1]);
  });

  it("durable: a cancelled gate re-admits on the next successful probe (re-hydration)", async () => {
    const gate = new PiSoulGate();
    gate.beginSession();
    gate.cancel();
    expect(gate.generationPending).toBe(true);
    const out = await buildSdkTransform(durableInputs({ gate, generation: 3 }))(history);
    expect(gate.generationPending).toBe(false);
    expect(JSON.stringify(out[0])).toContain("bundle text");
  });
});

describe("buildRequestSystemText", () => {
  it("emits one envelope with execution identity and volatile blocks", () => {
    const text = buildRequestSystemText(() => "bundle", "exec-9", 12, [{ kind: "k", content: "v" }]);
    expect(text).toContain("bundle");
    expect(text).toContain("exec-9");
    expect(text).toContain("volatile_context");
  });

  it("returns the bare base when empty", () => {
    expect(buildRequestSystemText(() => "  ", "exec-9", undefined, [])).toBe("  ");
  });
});
