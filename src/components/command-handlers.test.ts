import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCommand, type CommandContext } from "./commands/index.js";
import { Spin } from "./spin.js";
const SessionManager = Spin;
import { setUserRegistryOverride } from "./user-registry.js";
import type { CodingMode } from "./coding-mode.js";
import type { IdleSave } from "./idle-save.js";
import type { ManagedSession } from "./spin-types.js";

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
    const spinMod = await import("./spin.js");
    const session: Partial<ManagedSession> = { fullMode: false };
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session as ManagedSession);
    const handled = await handleCommand("/full", ctx);
    expect(handled).toBe(true);
    expect(session.fullMode).toBe(true);
    vi.restoreAllMocks();
  });

  it("/short disables full mode", async () => {
    const ctx = makeCtx();
    const spinMod = await import("./spin.js");
    const session: Partial<ManagedSession> = { fullMode: true };
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session as ManagedSession);
    const handled = await handleCommand("/short", ctx);
    expect(handled).toBe(true);
    expect(session.fullMode).toBeFalsy();
    vi.restoreAllMocks();
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

  it("/project bare root replies with usage", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("/project", ctx);
    expect(handled).toBe(true);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage: /project unquarantine"));
  });

  it("/project unquarantine with invalid id replies with usage", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("/project unquarantine 0", ctx);
    expect(handled).toBe(true);
    expect(ctx.reply).toHaveBeenCalledWith("Usage: /project unquarantine <id>");
  });

  it("/session new routes to the session handler", async () => {
    const createSession = vi.fn().mockReturnValue({ shortIndex: 2, id: "s2", sessionKey: "k" });
    const greetSession = vi.fn();
    const ctx = makeCtx({
      sessionManager: { ...(makeCtx().sessionManager as object), createSession, greetSession } as any,
    });
    const handled = await handleCommand("/session new code", ctx);
    expect(handled).toBe(true);
    expect(createSession).toHaveBeenCalledWith("test", "telegram", "C");
  });

  it("aliases still route to their canonical handlers", async () => {
    const ctx = makeCtx();
    expect(await handleCommand("/ctrlc", ctx)).toBe(true);
    expect(ctx.transport.sendInterrupt).toHaveBeenCalled();
    expect(await handleCommand("/model", ctx)).toBe(true);
    expect(await handleCommand("/health", ctx)).toBe(true);
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("/help on telegram includes telegram-only lines", async () => {
    const ctx = makeCtx();
    await handleCommand("/help", ctx);
    const reply = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(reply).toContain("/full — Raw output, TTS disabled");
    expect(reply).toContain("/help — Show this help");
  });

  it("/help on discord excludes telegram-only lines", async () => {
    const ctx = makeCtx({ platform: "discord" as const });
    await handleCommand("/help", ctx);
    const reply = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(reply).not.toContain("/full — Raw output, TTS disabled");
    expect(reply).not.toContain("/healing — Toggle self-healer on/off");
    expect(reply).toContain("/help — Show this help");
  });

  it("non-master users are denied master-only commands but allowed non-master roots", async () => {
    setUserRegistryOverride({
      users: [{ userId: "guest-1", role: "guest", maxClass: 0, tools: [], platforms: { telegram: 999 } }],
      byPlatformId: new Map([["telegram:999", { userId: "guest-1", role: "guest", maxClass: 0, tools: [], platforms: { telegram: 999 } }]]),
      byUserId: new Map([["guest-1", { userId: "guest-1", role: "guest", maxClass: 0, tools: [], platforms: { telegram: 999 } }]]),
    } as any);
    const ctx = makeCtx({ userId: "guest-1" });
    await handleCommand("/todo", ctx);
    expect(ctx.reply).toHaveBeenCalledWith("⛔ Owner-only command.");
    (ctx.reply as ReturnType<typeof vi.fn>).mockClear();
    expect(await handleCommand("/status", ctx)).toBe(true);
    expect(ctx.reply).toHaveBeenCalled();
  });

});

describe("command-handlers /task validate", () => {
  const origHome = process.env.HOME;
  const origAbtarsHome = process.env.ABTARS_HOME;
  let home: string;
  let taskRoot: string;

  beforeEach(() => {
    setUserRegistryOverride({
      users: [{ userId: "test", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 123 } }],
      byPlatformId: new Map([["telegram:123", { userId: "test", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 123 } }]]),
      byUserId: new Map([["test", { userId: "test", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 123 } }]]),
    } as any);
    home = mkdtempSync(join(tmpdir(), "cmd-tasks-valid-"));
    taskRoot = join(home, ".abtars", "tasks");
    process.env.HOME = home;
    process.env.ABTARS_HOME = join(home, ".abtars");
    mkdirSync(taskRoot, { recursive: true });
  });

  afterEach(() => {
    setUserRegistryOverride(null);
    process.env.HOME = origHome;
    if (origAbtarsHome === undefined) delete process.env.ABTARS_HOME;
    else process.env.ABTARS_HOME = origAbtarsHome;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
  });

  it("/task validate returns an OK summary for a clean registry", async () => {
    writeFileSync(join(taskRoot, "tasks.json"), "[]", "utf-8");
    const ctx = makeCtx();
    const handled = await handleCommand("/task validate", ctx);
    expect(handled).toBe(true);
    const reply = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(reply).toContain("Task validation: OK");
    expect(reply).toContain(`Path: ${join(taskRoot, "tasks.json")}`);
    expect(reply).toContain("Entries: 0");
    expect(reply).toContain("Valid entries: 0");
    expect(reply).toContain("Findings: 0");
  });

  it("/task validate reports FAILED with finding details for an invalid registry", async () => {
    writeFileSync(join(taskRoot, "tasks.json"), JSON.stringify([{ id: "bad-one" }]), "utf-8");
    const ctx = makeCtx();
    const handled = await handleCommand("/task validate", ctx);
    expect(handled).toBe(true);
    const reply = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(reply).toContain("Task validation: FAILED");
    expect(reply).toContain("Entries: 1");
    expect(reply).toContain("Findings: 1");
    expect(reply).toContain("entry_invalid");
    expect(reply).toContain("bad-one");
  });

  it("/task validate bounds the response and reports omitted findings", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({ id: `bad-${i}`, kind: "agent" }));
    writeFileSync(join(taskRoot, "tasks.json"), JSON.stringify(entries), "utf-8");
    const ctx = makeCtx();
    await handleCommand("/task validate", ctx);
    const reply = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(reply).toContain("Findings: 60");
    expect(reply).toContain("20 more findings omitted");
    expect(reply.length).toBeLessThan(4000);
  });

  it("/task validate with arguments returns usage without running validation", async () => {
    const ctx = makeCtx();
    const handled = await handleCommand("/task validate tasks.json", ctx);
    expect(handled).toBe(true);
    expect(ctx.reply).toHaveBeenCalledWith("Usage: /task validate");
  });

  it("/tasks validate routes to the same dry-run handler", async () => {
    writeFileSync(join(taskRoot, "tasks.json"), "[]", "utf-8");
    const ctx = makeCtx();
    await handleCommand("/tasks validate", ctx);
    const reply = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(reply).toContain("Task validation: OK");
  });

  it("/task validate never enqueues work or spawns the validator CLI", async () => {
    writeFileSync(join(taskRoot, "tasks.json"), "[]", "utf-8");
    const enqueueCron = vi.fn();
    const ctx = makeCtx({ enqueueCron });
    const { execFile } = await import("node:child_process") as { execFile: ReturnType<typeof vi.fn> };
    execFile.mockClear();
    await handleCommand("/task validate", ctx);
    expect(enqueueCron).not.toHaveBeenCalled();
    const abtarsTaskCalls = execFile.mock.calls.filter((c: unknown[]) => c[0] === "abtars-task");
    expect(abtarsTaskCalls).toHaveLength(0);
  });

});
