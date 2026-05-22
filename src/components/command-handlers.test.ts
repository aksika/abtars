import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCommand, type CommandContext } from "./commands/index.js";
import { SessionManager } from "./session-manager.js";
import { SessionRegistry } from "./session-registry.js";
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
    userId: "test",
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
    sessions: new SessionRegistry(),
    sessionManager: { endSession: vi.fn(), getActiveSessionId: () => "telegram:123", getActiveSession: () => ({ id: "telegram:123" }), setRuntime: vi.fn() } as any,
    updateCtxStart: vi.fn(),
    ...overrides,
  };
}

describe("command-handlers", () => {
  it("/new resets session and replies", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("/new", ctx);
    expect(handled).toBe(true);
    expect(ctx.transport.resetSession).toHaveBeenCalledWith(expect.any(String));
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("/coding activates coding mode", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("/coding", ctx);
    expect(handled).toBe(true);
    expect(ctx.codingMode.start).toHaveBeenCalledWith(expect.any(String));
  });

  it("/default deactivates coding mode", async () => {
    const ctx = makeCtx();
    (ctx.codingMode.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const handled = await handleCommand("/default", ctx);
    expect(handled).toBe(true);
    expect(ctx.codingMode.stop).toHaveBeenCalledWith(expect.any(String));
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
    expect(ctx.sessions.get("telegram:123")?.fullMode).toBe(true);
  });

  it("/short disables full mode", async () => {
    const ctx = makeCtx();
    ctx.sessions.getOrCreate("telegram:123").fullMode = true;
    const handled = await handleCommand("/short", ctx);
    expect(handled).toBe(true);
    expect(ctx.sessions.get("telegram:123")?.fullMode).toBeFalsy();
  });

  it("/cron trigger calls enqueueCron", async () => {
    const enqueueCron = vi.fn().mockReturnValue(null);
    const ctx = makeCtx({ enqueueCron });
    const handled = await handleCommand("/cron trigger abc123", ctx);
    expect(handled).toBe(true);
    expect(enqueueCron).toHaveBeenCalledWith("abc123", true);
    expect(ctx.reply).toHaveBeenCalledWith("⏳ Running: abc123");
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

  it("/status does NOT call mcporter (moved to /mcp)", async () => {
    const { execFile } = await import("node:child_process") as { execFile: ReturnType<typeof vi.fn> };
    execFile.mockClear();
    const ctx = makeCtx();
    await handleCommand("/status", ctx);
    const mcporterCalls = execFile.mock.calls.filter((c: unknown[]) => c[0] === "mcporter");
    expect(mcporterCalls).toHaveLength(0);
  });

  it("/mcp with mcporter missing: immediate reply, no placeholder edit", async () => {
    const { execFile } = await import("node:child_process") as { execFile: ReturnType<typeof vi.fn> };
    execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(new Error("ENOENT"), "");
      return { stderr: { resume: vi.fn() } };
    });
    const editReply = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ editReply });
    await handleCommand("/mcp", ctx);
    expect(ctx.reply).toHaveBeenCalledWith("📦 mcporter not installed");
    expect(editReply).not.toHaveBeenCalled();
  });

  it("/mcp happy path: placeholder + edit with server list", async () => {
    const { execFile } = await import("node:child_process") as { execFile: ReturnType<typeof vi.fn> };
    let call = 0;
    execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      call++;
      if (call === 1) cb(null, "mcporter 1.2.3");
      else cb(null, JSON.stringify({ servers: [{ name: "github", status: "ok", tools: 12 }, { name: "gmail", status: "error", error: "auth" }] }));
      return { stderr: { resume: vi.fn() } };
    });
    const reply = vi.fn().mockResolvedValue(42);  // placeholder id
    const editReply = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ reply, editReply });
    await handleCommand("/mcp", ctx);
    expect(reply).toHaveBeenCalledWith("📦 Checking MCP servers...");
    expect(editReply).toHaveBeenCalledWith(42, expect.stringContaining("github"));
    expect(editReply).toHaveBeenCalledWith(42, expect.stringContaining("gmail"));
  });

  it("/mcp without editReply (fallback): two separate messages", async () => {
    const { execFile } = await import("node:child_process") as { execFile: ReturnType<typeof vi.fn> };
    let call = 0;
    execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      call++;
      if (call === 1) cb(null, "mcporter 1.2.3");
      else cb(null, JSON.stringify({ servers: [{ name: "x", status: "ok", tools: 1 }] }));
      return { stderr: { resume: vi.fn() } };
    });
    const reply = vi.fn().mockResolvedValue(99);
    // editReply intentionally undefined — simulates platform without editMessage
    const ctx = makeCtx({ reply });
    await handleCommand("/mcp", ctx);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenNthCalledWith(1, "📦 Checking MCP servers...");
    expect(reply).toHaveBeenNthCalledWith(2, expect.stringContaining("MCP status"));
  });
});
