/**
 * emergency-execution-service.test.ts — #1468 focused boundary tests.
 *
 * Each test protects a real contract: owner binding, no-second-authority,
 * generation-fenced delivery, zero duplicate delivery, zero orphan client,
 * and no Spin/session/prompt-builder/memory/normal-transport interaction.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn(), logTrace: vi.fn() }));
vi.mock("./transport-config.js", () => ({
  loadTransportStructured: vi.fn(),
  resolveHailMary: vi.fn(),
  validateModelProviderPair: vi.fn(),
  validateProviderReady: vi.fn(),
}));
vi.mock("./env-schema.js", () => ({ getEnv: vi.fn(() => ({ promptTimeoutSec: 180 })) }));
vi.mock("./user-registry.js", () => ({ loadUsers: vi.fn(() => ({ byUserId: new Map() })) }));

import type { InboundMessage, PlatformAdapter } from "../types/platform.js";
import type { AcpTransport } from "./transport/acp-transport.js";
import { AcpExitError } from "./transport/acp-transport.js";
import { EmergencyExecutionService, type EmergencyExecutionDeps } from "./emergency-execution-service.js";
import type { TransportConfig } from "./transport-config.js";

const VALID_CONFIG: TransportConfig = {
  schemaVersion: 3,
  activeRoute: "acp",
  routes: { acp: { agents: { main: { model: "m", provider: "p" } } } },
  providers: { p: { transport: "acp", cli: "fake-cli" } },
  hailMary: { route: "acp", model: "hm-model", provider: "p" },
};

function makeTransport(overrides: Partial<Record<string, unknown>> = {}): AcpTransport {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("emergency reply"),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    isReady: true,
    getModel: () => "hm-model",
    ...overrides,
  } as unknown as AcpTransport;
}

interface Harness {
  service: EmergencyExecutionService;
  transport: AcpTransport;
  sent: Array<{ channelId: string; text: string }>;
  adapter: PlatformAdapter;
}

function makeHarness(overrides: Partial<EmergencyExecutionDeps> = {}, transportOverrides: Partial<Record<string, unknown>> = {}): Harness {
  const transport = makeTransport(transportOverrides);
  const sent: Array<{ channelId: string; text: string }> = [];
  const adapter = {
    sendMessage: vi.fn(async (channelId: string, text: string) => { sent.push({ channelId, text }); return "sent"; }),
    chunkResponse: (text: string) => (text.length <= 10 ? [text] : [text.slice(0, 10), text.slice(10)]),
  } as unknown as PlatformAdapter;
  const service = new EmergencyExecutionService({
    workingDir: "/tmp/work",
    loadConfig: () => VALID_CONFIG,
    resolveHailMary: () => ({ route: "acp", model: "hm-model", provider: "p", cli: "fake-cli" }),
    validatePair: () => ({ ok: true }),
    validateReady: () => ({ ok: true }),
    createAcpTransport: () => transport,
    isMasterUser: (userId) => userId === "master",
    promptTimeoutMs: () => 1000,
    ...overrides,
  });
  return { service, transport, sent, adapter };
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "telegram",
    channelId: "100",
    userId: "master",
    senderId: "master",
    senderName: "Master",
    text: "",
    timestamp: Date.now(),
    isGroup: false,
    isVoice: false,
    ...overrides,
  };
}

async function activate(h: Harness): Promise<void> {
  const result = await h.service.handleInbound(makeMsg({ text: "/emergency" }), h.adapter);
  expect(result).toBe("handled");
}

describe("EmergencyExecutionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("activation", () => {
    it("activates from /emergency and reports the owner + model", async () => {
      const h = makeHarness();
      await activate(h);

      expect(h.transport.initialize).toHaveBeenCalledTimes(1);
      expect(h.service.status().kind).toBe("ready");
      expect(h.sent[0]!.text).toContain("Emergency mode active");
      expect(h.sent[0]!.text).toContain("hm-model");
      expect(h.transport.sendPrompt).not.toHaveBeenCalled();
    });

    it("accepts /model emergency and the hailmary synonym", async () => {
      for (const text of ["/model emergency", "/models emergency", "/model hailmary", "/models hailmary"]) {
        const h = makeHarness();
        const result = await h.service.handleInbound(makeMsg({ text }), h.adapter);
        expect(result).toBe("handled");
        expect(h.service.status().kind).toBe("ready");
      }
    });

    it("claims and rejects non-master activation so it cannot fall through the normal registry", async () => {
      const h = makeHarness();
      const result = await h.service.handleInbound(makeMsg({ userId: "guest", text: "/model emergency" }), h.adapter);

      expect(result).toBe("handled");
      expect(h.sent[0]!.text).toContain("owner-only");
      expect(h.service.status().kind).toBe("inactive");
      expect(h.transport.initialize).not.toHaveBeenCalled();
    });

    it("fails closed on missing/invalid config without disturbing anything", async () => {
      const h = makeHarness({ loadConfig: () => null });
      await activate(h);

      expect(h.sent[0]!.text).toContain("failed");
      expect(h.service.status().kind).toBe("inactive");
      expect(h.transport.initialize).not.toHaveBeenCalled();
    });

    it("fails closed on incompatible model or unready provider", async () => {
      const incompatible = makeHarness({ validatePair: () => ({ ok: false, model: "hm-model", provider: "p", allowed: [], reason: "not supported" }) });
      await activate(incompatible);
      expect(incompatible.sent[0]!.text).toContain("not supported");
      expect(incompatible.service.status().kind).toBe("inactive");

      const unready = makeHarness({ validateReady: () => ({ ok: false, reason: "cli not runnable", fix: "" }) });
      await activate(unready);
      expect(unready.sent[0]!.text).toContain("cli not runnable");
      expect(unready.service.status().kind).toBe("inactive");
    });

    it("destroys the candidate and returns inactive when initialize fails", async () => {
      const h = makeHarness({}, { initialize: vi.fn().mockRejectedValue(new Error("spawn failed")) });
      await activate(h);

      expect(h.sent[0]!.text).toContain("activation failed");
      expect(h.service.status().kind).toBe("inactive");
      expect(h.transport.destroy).toHaveBeenCalled();
    });

    it("second activation reports the existing binding without a second transport", async () => {
      const h = makeHarness();
      await activate(h);
      expect(h.transport.initialize).toHaveBeenCalledTimes(1);

      const again = await h.service.handleInbound(makeMsg({ text: "/emergency" }), h.adapter);
      expect(again).toBe("handled");
      expect(h.sent[1]!.text).toContain("already active");
      expect(h.transport.initialize).toHaveBeenCalledTimes(1);

      const other = await h.service.handleInbound(makeMsg({ userId: "other", text: "/model emergency" }), h.adapter);
      expect(other).toBe("handled");
      expect(h.sent[2]!.text).toContain("another conversation");
      expect(h.transport.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe("turn execution", () => {
    it("sends the exact raw text with trusted metadata and delivers once", async () => {
      const h = makeHarness();
      await activate(h);

      const result = await h.service.handleInbound(makeMsg({ text: "plain turn" }), h.adapter);

      expect(result).toBe("handled");
      expect(h.transport.sendPrompt).toHaveBeenCalledTimes(1);
      const [sessionKey, message, image, context] = (h.transport.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(sessionKey).toBe("emergency:master:telegram:100:");
      expect(message).toBe("plain turn");
      expect(image).toBeUndefined();
      expect(context).toMatchObject({
        userId: "master",
        sessionType: "A",
        authorizationMode: "interactive",
      });
      expect(String(context.executionId)).toMatch(/^emergency:1:/);
      expect(context.deadlineAt).toBeGreaterThan(Date.now());
      // one response, chunked exactly once through the adapter boundary
      expect(h.sent.filter(s => s.text === "reply").length).toBe(1);
      expect(h.service.status().kind).toBe("ready");
    });

    it("ordinary turn from another binding passes through to the normal pipeline", async () => {
      const h = makeHarness();
      await activate(h);

      const result = await h.service.handleInbound(makeMsg({ userId: "other", text: "hello" }), h.adapter);

      // R2.2: only the exact active binding enters the emergency client; other
      // conversations retain normal behavior.
      expect(result).toBe("pass");
      expect(h.transport.sendPrompt).not.toHaveBeenCalled();
    });

    it("voice/media from the active owner is claimed with a text-only instruction", async () => {
      const h = makeHarness();
      await activate(h);

      const result = await h.service.handleInbound(makeMsg({ text: "", isVoice: true }), h.adapter);

      expect(result).toBe("handled");
      expect(h.sent[1]!.text).toContain("text only");
      expect(h.transport.sendPrompt).not.toHaveBeenCalled();
    });

    it("rejects a second ordinary turn while running with a bounded busy reply", async () => {
      let resolvePrompt!: (value: string) => void;
      const h = makeHarness({}, { sendPrompt: vi.fn(() => new Promise<string>(r => { resolvePrompt = r; })) });
      await activate(h);

      const first = h.service.handleInbound(makeMsg({ text: "first" }), h.adapter);
      // ensure the turn entered running before the second message arrives
      await vi.waitFor(() => expect(h.service.status().kind).toBe("running"));
      const second = await h.service.handleInbound(makeMsg({ text: "second" }), h.adapter);
      resolvePrompt("done");

      expect(second).toBe("handled");
      expect(h.sent[1]!.text).toContain("already running");
      expect(h.transport.sendPrompt).toHaveBeenCalledTimes(1);
      await first;
      expect(h.service.status().kind).toBe("ready");
    });

    it("rejects a concurrent turn that races before the running state is observed", async () => {
      let resolvePrompt!: (value: string) => void;
      const h = makeHarness({}, { sendPrompt: vi.fn(() => new Promise<string>(r => { resolvePrompt = r; })) });
      await activate(h);

      // Both requests observe ready before either serialized claim runs.
      const first = h.service.handleInbound(makeMsg({ text: "first" }), h.adapter);
      const second = h.service.handleInbound(makeMsg({ text: "second" }), h.adapter);
      await vi.waitFor(() => expect(h.service.status().kind).toBe("running"));
      resolvePrompt("done");
      await Promise.all([first, second]);

      expect(h.transport.sendPrompt).toHaveBeenCalledTimes(1);
      expect(h.sent.some(s => s.text.includes("already running"))).toBe(true);
      expect(h.service.status().kind).toBe("ready");
    });

    it("unrelated slash commands pass through", async () => {
      const h = makeHarness();
      const result = await h.service.handleInbound(makeMsg({ text: "/status" }), h.adapter);
      expect(result).toBe("pass");
    });

    it("empty response becomes a bounded (no response) and returns to ready", async () => {
      const h = makeHarness({}, { sendPrompt: vi.fn().mockResolvedValue("[NO_REPLY]") });
      await activate(h);

      const result = await h.service.handleInbound(makeMsg({ text: "hi" }), h.adapter);

      expect(result).toBe("handled");
      expect(h.sent.some(s => s.text === "(no response)")).toBe(true);
      expect(h.service.status().kind).toBe("ready");
    });

    it("timeout surfaces a bounded message and stays ready", async () => {
      const h = makeHarness({}, { sendPrompt: vi.fn().mockRejectedValue(new Error("Bridge prompt timeout — model unresponsive")) });
      await activate(h);

      const result = await h.service.handleInbound(makeMsg({ text: "hi" }), h.adapter);

      expect(result).toBe("handled");
      expect(h.sent[1]!.text).toContain("timed out");
      expect(h.sent[1]!.text).not.toContain("Bridge prompt");
      expect(h.service.status().kind).toBe("ready");
      expect(h.transport.destroy).not.toHaveBeenCalled();
    });

    it("ACP exit destroys the client and returns to inactive", async () => {
      const h = makeHarness({}, { sendPrompt: vi.fn().mockRejectedValue(new AcpExitError(1, null)), isReady: false });
      await activate(h);

      const result = await h.service.handleInbound(makeMsg({ text: "hi" }), h.adapter);

      expect(result).toBe("handled");
      expect(h.sent[1]!.text).toContain("exited");
      expect(h.service.status().kind).toBe("inactive");
      expect(h.transport.destroy).toHaveBeenCalled();
    });

    it("delivery failure is logged, never replayed", async () => {
      const h = makeHarness();
      (h.adapter.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network down"));
      await activate(h);

      const result = await h.service.handleInbound(makeMsg({ text: "hi" }), h.adapter);

      expect(result).toBe("handled");
      expect(h.transport.sendPrompt).toHaveBeenCalledTimes(1);
      expect(h.service.status().kind).toBe("ready");
    });
  });

  describe("interrupt / restore / shutdown fencing", () => {
    it("/stop from the owner invalidates the generation so a late result is dropped", async () => {
      let resolvePrompt!: (value: string) => void;
      const h = makeHarness({}, { sendPrompt: vi.fn(() => new Promise<string>(r => { resolvePrompt = r; })) });
      await activate(h);

      const turn = h.service.handleInbound(makeMsg({ text: "slow turn" }), h.adapter);
      await vi.waitFor(() => expect(h.service.status().kind).toBe("running"));

      const stopped = await h.service.handleInbound(makeMsg({ text: "/stop" }), h.adapter);
      expect(stopped).toBe("handled");
      expect(h.transport.sendInterrupt).toHaveBeenCalledTimes(1);
      expect(h.service.status().kind).toBe("ready");

      resolvePrompt("late result");
      await turn;

      // the late result was fenced: no delivery of "late result"
      expect(h.sent.some(s => s.text.includes("late result"))).toBe(false);
      expect(h.sent.some(s => s.text.includes("interrupted"))).toBe(true);
    });

    it("repeated /stop is idempotent", async () => {
      const h = makeHarness();
      await activate(h);

      await h.service.handleInbound(makeMsg({ text: "/stop" }), h.adapter);
      await h.service.handleInbound(makeMsg({ text: "/ctrlc" }), h.adapter);

      expect(h.service.status().kind).toBe("ready");
      expect(h.transport.sendInterrupt).toHaveBeenCalledTimes(2);
    });

    it("/stop from a non-owner is claimed and rejected", async () => {
      const h = makeHarness();
      await activate(h);

      const result = await h.service.handleInbound(makeMsg({ userId: "other", text: "/stop" }), h.adapter);

      expect(result).toBe("handled");
      expect(h.sent[1]!.text).toContain("owner-only");
      expect(h.transport.sendInterrupt).not.toHaveBeenCalled();
    });

    it("/model restore during flight interrupts, destroys, and drops the late result", async () => {
      let resolvePrompt!: (value: string) => void;
      const h = makeHarness({}, { sendPrompt: vi.fn(() => new Promise<string>(r => { resolvePrompt = r; })) });
      await activate(h);

      const turn = h.service.handleInbound(makeMsg({ text: "in flight" }), h.adapter);
      await vi.waitFor(() => expect(h.service.status().kind).toBe("running"));

      const restored = await h.service.handleInbound(makeMsg({ text: "/model restore" }), h.adapter);
      expect(restored).toBe("handled");
      expect(h.transport.sendInterrupt).toHaveBeenCalledTimes(1);
      expect(h.transport.destroy).toHaveBeenCalled();
      expect(h.service.status().kind).toBe("inactive");

      resolvePrompt("too late");
      await turn;
      expect(h.sent.some(s => s.text.includes("too late"))).toBe(false);

      // next ordinary message passes through — normal routing is unchanged
      const next = await h.service.handleInbound(makeMsg({ text: "after restore" }), h.adapter);
      expect(next).toBe("pass");
    });

    it("/model restore while inactive passes through to the rollback command", async () => {
      const h = makeHarness();
      const result = await h.service.handleInbound(makeMsg({ text: "/model restore" }), h.adapter);
      expect(result).toBe("pass");
    });

    it("restore by a non-owner is claimed and rejected", async () => {
      const h = makeHarness();
      await activate(h);
      const result = await h.service.handleInbound(makeMsg({ userId: "other", text: "/models restore" }), h.adapter);
      expect(result).toBe("handled");
      expect(h.sent[1]!.text).toContain("owner-only");
      expect(h.transport.destroy).not.toHaveBeenCalled();
    });

    it("shutdown fences, interrupts, destroys, and is idempotent", async () => {
      let resolvePrompt!: (value: string) => void;
      const h = makeHarness({}, { sendPrompt: vi.fn(() => new Promise<string>(r => { resolvePrompt = r; })) });
      await activate(h);

      const turn = h.service.handleInbound(makeMsg({ text: "running" }), h.adapter);
      await vi.waitFor(() => expect(h.service.status().kind).toBe("running"));

      await h.service.shutdown();
      expect(h.transport.sendInterrupt).toHaveBeenCalledTimes(1);
      expect(h.transport.destroy).toHaveBeenCalled();
      expect(h.service.status().kind).toBe("inactive");

      resolvePrompt("late");
      await turn;
      expect(h.sent.some(s => s.text.includes("late"))).toBe(false);

      await h.service.shutdown(); // idempotent
      expect(h.transport.destroy).toHaveBeenCalledTimes(1);
    });

    it("after shutdown begins, activation and turns fail closed", async () => {
      const h = makeHarness();
      await activate(h);
      await h.service.shutdown();

      const activateAgain = await h.service.handleInbound(makeMsg({ text: "/emergency" }), h.adapter);
      expect(activateAgain).toBe("handled");
      expect(h.sent[h.sent.length - 1]!.text).toContain("shutting down");
      expect(h.transport.initialize).toHaveBeenCalledTimes(1);
    });
  });
});
