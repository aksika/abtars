/**
 * wire-platform.test.ts — #1306 retry-path adapter wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBootCtx } from "./context.js";
import type { BootCtx } from "./context.js";
import type { PipelineDeps } from "../components/message-pipeline.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../components/transport/tool-registry.js", () => ({
  setSendDocument: vi.fn(),
  setIrcSend: vi.fn(),
}));

vi.mock("../components/message-pipeline.js", () => ({
  handleInboundMessage: vi.fn().mockResolvedValue(undefined),
}));

function makeMockPipelineDeps(): PipelineDeps {
  return { handleInbound: vi.fn() } as unknown as PipelineDeps;
}

function makeMockTransport() {
  return { isReady: true } as unknown as BootCtx["transport"];
}

function makeTelegramAdapter() {
  return {
    setMessageHandler: vi.fn(),
    sendDocument: vi.fn(),
    api: { sendMessage: vi.fn() },
  };
}

function makeDiscordAdapter() {
  return { setMessageHandler: vi.fn() };
}

function makeIrcAdapter() {
  return {
    setMessageHandler: vi.fn(),
    sendMessage: vi.fn(),
  };
}

function makeTuiAdapter() {
  return {
    setMessageHandler: vi.fn(),
  };
}

// ── wireTelegram ───────────────────────────────────────────────────────────

describe("wireTelegram (#1306)", () => {
  it("is a no-op when ctx.pipelineDeps is null", async () => {
    const ctx = createBootCtx();
    const adapter = makeTelegramAdapter();
    ctx.telegramAdapter = adapter as unknown as BootCtx["telegramAdapter"];
    ctx.pipelineDeps = null;

    const { wireTelegram } = await import("./wire-platform.js");
    await wireTelegram(ctx);

    expect(adapter.setMessageHandler).not.toHaveBeenCalled();
  });

  it("is a no-op when telegramAdapter is null", async () => {
    const ctx = createBootCtx();
    ctx.pipelineDeps = makeMockPipelineDeps();
    ctx.transport = makeMockTransport();
    ctx.telegramAdapter = null;

    const { wireTelegram } = await import("./wire-platform.js");
    await wireTelegram(ctx); // should not throw
  });

  it("calls setMessageHandler with full pipeline deps on retry path", async () => {
    const ctx = createBootCtx();
    const adapter = makeTelegramAdapter();
    ctx.telegramAdapter = adapter as unknown as BootCtx["telegramAdapter"];
    ctx.pipelineDeps = makeMockPipelineDeps();
    ctx.transport = makeMockTransport();
    ctx.config = { mainChatId: null } as unknown as BootCtx["config"];

    const { wireTelegram } = await import("./wire-platform.js");
    await wireTelegram(ctx);

    expect(adapter.setMessageHandler).toHaveBeenCalledOnce();
    const call = adapter.setMessageHandler.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["pipeline"]).toBe(ctx.pipelineDeps);
    expect(call["transport"]).toBe(ctx.transport);
  });
});

// ── wireDiscord ────────────────────────────────────────────────────────────

describe("wireDiscord (#1306)", () => {
  it("is a no-op when ctx.pipelineDeps is null", async () => {
    const ctx = createBootCtx();
    const adapter = makeDiscordAdapter();
    ctx.discordAdapter = adapter as unknown as BootCtx["discordAdapter"];
    ctx.pipelineDeps = null;

    const { wireDiscord } = await import("./wire-platform.js");
    await wireDiscord(ctx);

    expect(adapter.setMessageHandler).not.toHaveBeenCalled();
  });

  it("wires full handler on retry path", async () => {
    const ctx = createBootCtx();
    const adapter = makeDiscordAdapter();
    ctx.discordAdapter = adapter as unknown as BootCtx["discordAdapter"];
    ctx.pipelineDeps = makeMockPipelineDeps();
    ctx.transport = makeMockTransport();
    ctx.config = { mainChatId: null } as unknown as BootCtx["config"];

    const { wireDiscord } = await import("./wire-platform.js");
    await wireDiscord(ctx);

    expect(adapter.setMessageHandler).toHaveBeenCalledOnce();
  });
});

// ── wireIrc ────────────────────────────────────────────────────────────────

describe("wireIrc (#1306)", () => {
  it("is a no-op when no IRC adapter is registered", async () => {
    const ctx = createBootCtx();
    ctx.pipelineDeps = makeMockPipelineDeps();
    // no irc adapter in platformAdapters

    const { wireIrc } = await import("./wire-platform.js");
    await wireIrc(ctx); // should not throw
  });

  it("wires handler on retry path", async () => {
    const ctx = createBootCtx();
    const adapter = makeIrcAdapter();
    ctx.platformAdapters.set("irc", adapter as unknown as import("../types/platform.js").PlatformAdapter);
    ctx.pipelineDeps = makeMockPipelineDeps();

    const { wireIrc } = await import("./wire-platform.js");
    await wireIrc(ctx);

    expect(adapter.setMessageHandler).toHaveBeenCalledOnce();
  });
});

// ── wireTui (#1315) ───────────────────────────────────────────────────

describe("wireTui (#1315)", () => {
  it("is a no-op when no TUI adapter is registered", async () => {
    const ctx = createBootCtx();
    ctx.pipelineDeps = makeMockPipelineDeps();

    const { wireTui } = await import("./wire-platform.js");
    await wireTui(ctx); // should not throw
  });

  it("is a no-op when ctx.pipelineDeps is null", async () => {
    const ctx = createBootCtx();
    const adapter = makeTuiAdapter();
    ctx.platformAdapters.set("tui", adapter as unknown as import("../types/platform.js").PlatformAdapter);
    ctx.pipelineDeps = null;

    const { wireTui } = await import("./wire-platform.js");
    await wireTui(ctx);

    expect(adapter.setMessageHandler).not.toHaveBeenCalled();
  });

  it("wires handler on retry path", async () => {
    const ctx = createBootCtx();
    const adapter = makeTuiAdapter();
    ctx.platformAdapters.set("tui", adapter as unknown as import("../types/platform.js").PlatformAdapter);
    ctx.pipelineDeps = makeMockPipelineDeps();

    const { wireTui } = await import("./wire-platform.js");
    await wireTui(ctx);

    expect(adapter.setMessageHandler).toHaveBeenCalledOnce();
  });
});

// ── drainRecoveryQueue ─────────────────────────────────────────────────────

describe("drainRecoveryQueue (#1306)", () => {
  it("is a no-op when queue is empty", async () => {
    const ctx = createBootCtx();
    ctx.pipelineDeps = makeMockPipelineDeps();
    (ctx as unknown as { _recoveryQueue: unknown[] })._recoveryQueue = [];

    const { drainRecoveryQueue } = await import("./wire-platform.js");
    await drainRecoveryQueue(ctx); // should not throw
  });

  it("is a no-op when pipelineDeps is null", async () => {
    const ctx = createBootCtx();
    ctx.pipelineDeps = null;
    const msg = { text: "/status" };
    const adapter = makeTelegramAdapter();
    (ctx as unknown as { _recoveryQueue: unknown[] })._recoveryQueue = [{ msg, adapter }];

    const { drainRecoveryQueue } = await import("./wire-platform.js");
    await drainRecoveryQueue(ctx);

    const { handleInboundMessage } = await import("../components/message-pipeline.js");
    expect(handleInboundMessage).not.toHaveBeenCalled();
  });

  it("drains queued messages through handleInboundMessage and empties the queue", async () => {
    const ctx = createBootCtx();
    ctx.pipelineDeps = makeMockPipelineDeps();
    const msg1 = { text: "/status" };
    const msg2 = { text: "hello" };
    const adapter = makeTelegramAdapter();
    const queue: unknown[] = [{ msg: msg1, adapter }, { msg: msg2, adapter }];
    (ctx as unknown as { _recoveryQueue: unknown[] })._recoveryQueue = queue;

    const { drainRecoveryQueue } = await import("./wire-platform.js");
    await drainRecoveryQueue(ctx);

    const { handleInboundMessage } = await import("../components/message-pipeline.js");
    expect(handleInboundMessage).toHaveBeenCalledTimes(2);
    expect(queue).toHaveLength(0);
  });
});
