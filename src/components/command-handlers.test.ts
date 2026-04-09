import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCommand, type CommandContext } from "./command-handlers.js";
import type { CodingMode } from "./coding-mode.js";
import type { IdleSave } from "./idle-save.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    cb(null, "{}");
    return { stderr: { resume: vi.fn() } };
  }),
}));

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    sessionKey: "telegram:123",
    chatId: 123,
    platform: "telegram",
    reply: vi.fn().mockResolvedValue(undefined),
    transport: {
      sendPrompt: vi.fn().mockResolvedValue("ok"),
      resetSession: vi.fn().mockResolvedValue(undefined),
      sendInterrupt: vi.fn().mockResolvedValue(undefined),
      initialize: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
      isReady: true,
    },
    config: { agentTransport: "acp", workingDir: "/tmp", discordA2aEnabled: false },
    startedAt: Date.now(),
    memory: null,
    memoryConfig: { memoryEnabled: false, memoryDir: "/tmp" },
    nlmConfig: { enabled: false },
    codingMode: { has: vi.fn().mockReturnValue(false), start: vi.fn(), stop: vi.fn(), getTransport: vi.fn() } as unknown as CodingMode,
    idleSave: { reset: vi.fn(), stop: vi.fn(), save: vi.fn().mockResolvedValue(undefined) } as unknown as IdleSave,
    busyChats: new Set(),
    fullModeChats: new Set(),
    pendingSessionStart: new Set(),
    updateCtxStart: vi.fn(),
    ...overrides,
  };
}

describe("command-handlers", () => {
  it("/new resets session and replies", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("/new", ctx);
    expect(handled).toBe(true);
    expect(ctx.transport.resetSession).toHaveBeenCalledWith("telegram:123");
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("/coding activates coding mode", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("/coding", ctx);
    expect(handled).toBe(true);
    expect(ctx.codingMode.start).toHaveBeenCalledWith("telegram:123");
  });

  it("/default deactivates coding mode", async () => {
    const ctx = makeCtx();
    (ctx.codingMode.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const handled = await handleCommand("/default", ctx);
    expect(handled).toBe(true);
    expect(ctx.codingMode.stop).toHaveBeenCalledWith("telegram:123");
  });

  it("/stop sends interrupt", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("/stop", ctx);
    expect(handled).toBe(true);
    expect(ctx.transport.sendInterrupt).toHaveBeenCalled();
  });

  it("/full enables full mode", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("/full", ctx);
    expect(handled).toBe(true);
    expect(ctx.fullModeChats.has("telegram:123")).toBe(true);
  });

  it("/short disables full mode", async () => {
    const ctx = makeCtx();
    ctx.fullModeChats.add("telegram:123");
    const handled = await handleCommand("/short", ctx);
    expect(handled).toBe(true);
    expect(ctx.fullModeChats.has("telegram:123")).toBe(false);
  });

  it("/cron trigger calls enqueueCron", async () => {
    const enqueueCron = vi.fn().mockReturnValue(null);
    const ctx = makeCtx({ enqueueCron });
    const handled = await handleCommand("/cron trigger abc123", ctx);
    expect(handled).toBe(true);
    expect(enqueueCron).toHaveBeenCalledWith("abc123");
    expect(ctx.reply).toHaveBeenCalledWith("✓ Triggered abc123");
  });

  it("/cron trigger shows error on failure", async () => {
    const enqueueCron = vi.fn().mockReturnValue("❌ Not found");
    const ctx = makeCtx({ enqueueCron });
    await handleCommand("/cron trigger bad", ctx);
    expect(ctx.reply).toHaveBeenCalledWith("❌ Not found");
  });

  it("/help returns true", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("/help", ctx);
    expect(handled).toBe(true);
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("non-command returns false", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("hello world", ctx);
    expect(handled).toBe(false);
  });

  it("unknown /command replies with suggestion", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("/foobar", ctx);
    expect(handled).toBe(true);
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("/status replies with status info", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("/status", ctx);
    expect(handled).toBe(true);
    expect(ctx.reply).toHaveBeenCalled();
  });
});
