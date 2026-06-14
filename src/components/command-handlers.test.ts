import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleCommand, type CommandContext } from "./commands/index.js";
import { Spin } from "./spin.js";
const SessionManager = Spin;
import { SessionRegistry } from "./session-registry.js";
import { setUserRegistryOverride } from "./user-registry.js";
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
  beforeEach(() => {
    setUserRegistryOverride({
      users: [{ userId: "test", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 123 } }],
      byPlatformId: new Map([["telegram:123", { userId: "test", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 123 } }]]),
      byUserId: new Map([["test", { userId: "test", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 123 } }]]),
    } as any);
  });
  afterEach(() => { setUserRegistryOverride(null); });

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

  it("/task run calls enqueueCron", async () => {
    const enqueueCron = vi.fn().mockReturnValue(null);
    const ctx = makeCtx({ enqueueCron });
    const handled = await handleCommand("/task run abc123", ctx);
    expect(handled).toBe(true);
    expect(enqueueCron).toHaveBeenCalledWith("abc123", true);
  });

  it("/task run shows error on failure", async () => {
    const enqueueCron = vi.fn().mockReturnValue("❌ Not found");
    const ctx = makeCtx({ enqueueCron });
    await handleCommand("/task run bad", ctx);
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

});
