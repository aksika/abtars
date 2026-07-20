import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { runNpmUpdate } from "./handlers-system.js";
import type { CommandContext } from "./types.js";
import type { NpmUpdateChannel } from "./handlers-system.js";

interface SpawnRecord {
  cmd: string;
  args: string[];
  options: Record<string, unknown>;
}

function makeSpawnMock() {
  const calls: SpawnRecord[] = [];
  const children: Array<EventEmitter & { stderr: EventEmitter; unref: () => void }> = [];

  const spawn = ((cmd: string, args: string[], options: Record<string, unknown>) => {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; unref: () => void; kill: () => void };
    child.stderr = new EventEmitter();
    child.unref = () => {};
    child.kill = () => {};
    calls.push({ cmd, args, options });
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  return { spawn, calls, children };
}

function makeCtx(): CommandContext & { replies: string[] } {
  const replies: string[] = [];
  return {
    userId: "master",
    chatId: "123",
    platform: "telegram",
    memoryConfig: { memoryEnabled: false },
    reply: async (msg: string) => { replies.push(msg); },
    replies,
  } as unknown as CommandContext & { replies: string[] };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── argv selection ──────────────────────────────────────────────────────────

describe("runNpmUpdate — argv selection", () => {
  it("alpha uses --tag alpha", async () => {
    const ctx = makeCtx();
    const { spawn, calls } = makeSpawnMock();

    await runNpmUpdate(ctx, "alpha", spawn as typeof import("node:child_process").spawn);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["update", "--source", "npm", "--tag", "alpha"]);
  });

  it("stable omits --tag", async () => {
    const ctx = makeCtx();
    const { spawn, calls } = makeSpawnMock();

    await runNpmUpdate(ctx, "stable", spawn as typeof import("node:child_process").spawn);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["update", "--source", "npm"]);
  });
});

// ── spawn options ───────────────────────────────────────────────────────────

describe("runNpmUpdate — spawn options", () => {
  it("sets detached: true and stderr pipe", async () => {
    const ctx = makeCtx();
    const { spawn, calls } = makeSpawnMock();

    await runNpmUpdate(ctx, "alpha", spawn as typeof import("node:child_process").spawn);

    expect(calls[0]!.options.detached).toBe(true);
    expect(calls[0]!.options.stdio).toEqual(["ignore", "ignore", "pipe"]);
  });

  it("calls unref() on the child", async () => {
    const ctx = makeCtx();
    const { spawn, children } = makeSpawnMock();
    let unrefCalled = false;
    const originalSpawn = spawn;
    const trackedSpawn = ((cmd: string, args: string[], options: Record<string, unknown>) => {
      const child = originalSpawn(cmd, args, options);
      const origUnref = child.unref;
      child.unref = () => { unrefCalled = true; origUnref(); };
      return child;
    }) as unknown as typeof import("node:child_process").spawn;

    await runNpmUpdate(ctx, "alpha", trackedSpawn);

    expect(unrefCalled).toBe(true);
  });
});

// ── success ─────────────────────────────────────────────────────────────────

describe("runNpmUpdate — success", () => {
  it("does not reply on exit code 0", async () => {
    const ctx = makeCtx();
    const { spawn, children } = makeSpawnMock();

    await runNpmUpdate(ctx, "alpha", spawn as typeof import("node:child_process").spawn);
    children[0]!.emit("close", 0, null);

    expect(ctx.replies).toHaveLength(0);
  });
});

// ── non-zero exit ───────────────────────────────────────────────────────────

describe("runNpmUpdate — non-zero exit", () => {
  it("replies with exit code and stderr tail", async () => {
    const ctx = makeCtx();
    const { spawn, children } = makeSpawnMock();

    await runNpmUpdate(ctx, "alpha", spawn as typeof import("node:child_process").spawn);
    children[0]!.stderr.emit("data", Buffer.from("some error detail line\n"));
    children[0]!.emit("close", 1, null);

    expect(ctx.replies.some(r => r.includes("exit 1"))).toBe(true);
    expect(ctx.replies.some(r => r.includes("some error detail"))).toBe(true);
  });

  it("does not duplicate reply on error+close", async () => {
    const ctx = makeCtx();
    const { spawn, children } = makeSpawnMock();

    await runNpmUpdate(ctx, "alpha", spawn as typeof import("node:child_process").spawn);
    const err = new Error("spawn ENOENT");
    (err as NodeJS.ErrnoException).code = "ENOENT";
    children[0]!.emit("error", err);
    children[0]!.emit("close", 1, null);

    expect(ctx.replies).toHaveLength(1);
  });
});

// ── spawn error ─────────────────────────────────────────────────────────────

describe("runNpmUpdate — spawn error", () => {
  it("replies with code and message on ENOENT", async () => {
    const ctx = makeCtx();
    const { spawn, children } = makeSpawnMock();

    await runNpmUpdate(ctx, "alpha", spawn as typeof import("node:child_process").spawn);
    const err = new Error("spawn abtars ENOENT");
    (err as NodeJS.ErrnoException).code = "ENOENT";
    children[0]!.emit("error", err);

    expect(ctx.replies.some(r => r.includes("ENOENT"))).toBe(true);
    expect(ctx.replies.some(r => r.includes("failed to start"))).toBe(true);
  });

  it("replies with message when code is absent", async () => {
    const ctx = makeCtx();
    const { spawn, children } = makeSpawnMock();

    await runNpmUpdate(ctx, "alpha", spawn as typeof import("node:child_process").spawn);
    children[0]!.emit("error", new Error("something went wrong"));

    expect(ctx.replies.some(r => r.includes("failed to start"))).toBe(true);
    expect(ctx.replies.some(r => r.includes("something went wrong"))).toBe(true);
  });
});

// ── timeout ─────────────────────────────────────────────────────────────────

describe("runNpmUpdate — timeout", () => {
  it("replies timed out after 180s", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const { spawn, children } = makeSpawnMock();

    await runNpmUpdate(ctx, "alpha", spawn as typeof import("node:child_process").spawn);
    vi.advanceTimersByTime(180_001);

    expect(ctx.replies.some(r => r.includes("timed out"))).toBe(true);
  });

  it("includes stderr tail in timeout message", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const { spawn, children } = makeSpawnMock();

    await runNpmUpdate(ctx, "alpha", spawn as typeof import("node:child_process").spawn);
    children[0]!.stderr.emit("data", Buffer.from("ongoing output before timeout"));
    vi.advanceTimersByTime(180_001);

    expect(ctx.replies.some(r => r.includes("ongoing output before timeout"))).toBe(true);
  });

  it("does not duplicate on timeout+close", async () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    const { spawn, children } = makeSpawnMock();

    await runNpmUpdate(ctx, "alpha", spawn as typeof import("node:child_process").spawn);
    vi.advanceTimersByTime(180_001);
    children[0]!.emit("close", null, "SIGKILL");

    expect(ctx.replies).toHaveLength(1);
  });
});

// ── signal termination ──────────────────────────────────────────────────────

describe("runNpmUpdate — signal termination", () => {
  it("replies with signal name", async () => {
    const ctx = makeCtx();
    const { spawn, children } = makeSpawnMock();

    await runNpmUpdate(ctx, "alpha", spawn as typeof import("node:child_process").spawn);
    children[0]!.emit("close", null, "SIGTERM");

    expect(ctx.replies.some(r => r.includes("SIGTERM"))).toBe(true);
    expect(ctx.replies.some(r => r.includes("terminated"))).toBe(true);
  });
});
