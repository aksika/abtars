import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionRegistry } from "./session-registry.js";
import { SessionManager } from "./session-manager.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    cb(null, "{}");
    return { stderr: { resume: vi.fn() } };
  }),
  spawn: vi.fn(() => ({ pid: 1, unref: vi.fn(), stderr: { resume: vi.fn() } })),
}));

const bridgeLock = vi.hoisted(() => ({
  readBridgeLockField: vi.fn().mockReturnValue(null),
  writeForceSleep: vi.fn(),
  writeSleepStatus: vi.fn(),
}));
vi.mock("./transport/bridge-lock-transport.js", () => bridgeLock);

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn().mockReturnValue("{}"),
  readdirSync: vi.fn().mockReturnValue([] as string[]),
  unlinkSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
  writeFileSync: vi.fn(),
}));
vi.mock("node:fs", () => fsMock);

import { handleCommand } from "./commands/index.js";
import type { CommandContext } from "./commands/types.js";
import type { CodingMode } from "./coding-mode.js";
import type { IdleSave } from "./idle-save.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    sessionKey: "telegram:123",
    chatId: 123,
    userId: "master",
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
    memoryConfig: { memoryEnabled: true, memoryDir: "/tmp/mem" },
    nlmConfig: { enabled: false },
    codingMode: { has: vi.fn().mockReturnValue(false), start: vi.fn(), stop: vi.fn(), getTransport: vi.fn() } as unknown as CodingMode,
    idleSave: { reset: vi.fn(), stop: vi.fn(), save: vi.fn().mockResolvedValue(undefined) } as unknown as IdleSave,
    sessions: new SessionRegistry(),
    sessionManager: new SessionManager(),
    updateCtxStart: vi.fn(),
    ...overrides,
  };
}

describe("/sleep commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridgeLock.readBridgeLockField.mockReturnValue(null);
  });

  it("/sleep shows status with last cycle info", async () => {
    fsMock.readdirSync.mockReturnValue(["sleep_20260421.lock"]);
    fsMock.readFileSync.mockReturnValue(JSON.stringify({
      status: "suspended", llmCalls: 16,
      steps: { "gc-noise": { status: "failed" }, "daily-summary": { status: "ok" }, "feedback": { status: "skipped" } },
    }));
    const ctx = makeCtx();
    const handled = await handleCommand("/sleep", ctx);
    expect(handled).toBe(true);
    const reply = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(reply).toContain("1 ok, 1 failed, 1 skipped");
    expect(reply).toContain("suspended");
    expect(reply).toContain("16 LLM calls");
  });

  it("/sleep resume calls writeForceSleep when failed steps exist", async () => {
    fsMock.readdirSync.mockReturnValue(["sleep_20260421.lock"]);
    fsMock.readFileSync.mockReturnValue(JSON.stringify({
      status: "suspended", steps: { "gc-noise": { status: "failed" }, "daily-summary": { status: "ok" } },
    }));
    const ctx = makeCtx();
    await handleCommand("/sleep resume", ctx);
    expect(bridgeLock.writeForceSleep).toHaveBeenCalledWith(expect.stringContaining("resume"));
  });

  it("/sleep resume rejects when no failed cycle", async () => {
    fsMock.readdirSync.mockReturnValue(["sleep_20260421.lock"]);
    fsMock.readFileSync.mockReturnValue(JSON.stringify({
      status: "completed", steps: { "daily-summary": { status: "ok" } },
    }));
    const ctx = makeCtx();
    await handleCommand("/sleep resume", ctx);
    expect(bridgeLock.writeForceSleep).not.toHaveBeenCalled();
    const reply = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(reply).toContain("No failed sleep cycle");
  });

  it("/sleep now deletes lock and triggers fresh cycle", async () => {
    const ctx = makeCtx();
    await handleCommand("/sleep now", ctx);
    expect(fsMock.unlinkSync).toHaveBeenCalled();
    expect(bridgeLock.writeForceSleep).toHaveBeenCalledWith(expect.stringContaining("fresh"));
  });

  it("/sleep now rejects when already sleeping", async () => {
    bridgeLock.readBridgeLockField.mockImplementation((key: string) => key === "sleepStatus" ? "sleeping" : null);
    const ctx = makeCtx();
    await handleCommand("/sleep now", ctx);
    expect(bridgeLock.writeForceSleep).not.toHaveBeenCalled();
    const reply = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(reply).toContain("already running");
  });
});
