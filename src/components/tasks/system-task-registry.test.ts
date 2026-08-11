/**
 * system-task-registry.test.ts — allowlisted in-process executor (#1321).
 *
 * Verifies unknown actions never fall through to another executor, duplicate
 * registration is rejected, dispatch passes the read-only entry, a throwing
 * handler surfaces as a visible failure, and the run context reaches the
 * handler (#1603).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getSystemTaskRegistry, _resetSystemTaskRegistry, type SystemTaskResult, type SystemTaskContext } from "./system-task-registry.js";
import type { ScheduledTask } from "./task-types.js";

function systemEntry(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sleep-cycle",
    kind: "system",
    action: "sleep-cycle",
    schedule: "0 2 * * *",
    enabled: true,
    priority: "medium",
    delivery: "silent",
    ...overrides,
  };
}

describe("#1321 SystemTaskRegistry", () => {
  beforeEach(() => _resetSystemTaskRegistry());

  it("dispatches a registered action and returns its result", async () => {
    const reg = getSystemTaskRegistry();
    let seen: ScheduledTask | null = null;
    reg.register("sleep-cycle", (entry) => {
      seen = entry as ScheduledTask;
      return { status: "ok", detail: "completed" };
    });
    const entry = systemEntry();
    const result = await reg.dispatch(entry, { progress: () => {}, signal: new AbortController().signal });
    expect(result).toEqual({ status: "ok", detail: "completed" });
    expect(seen).not.toBeNull();
    expect((seen as ScheduledTask).id).toBe("sleep-cycle");
  });

  it("forwards the run context (progress + signal) to the handler (#1603)", async () => {
    const reg = getSystemTaskRegistry();
    let seenCtx: SystemTaskContext | null = null;
    const controller = new AbortController();
    const progressCalls: string[] = [];
    reg.register("sleep-cycle", (_entry, ctx) => {
      seenCtx = ctx;
      ctx.progress("halfway");
      return { status: "ok" };
    });
    const result = await reg.dispatch(systemEntry(), { progress: (d) => progressCalls.push(d ?? ""), signal: controller.signal });
    expect(result.status).toBe("ok");
    expect(seenCtx).not.toBeNull();
    expect(seenCtx!.signal).toBe(controller.signal);
    expect(progressCalls).toEqual(["halfway"]);
  });

  it("rejects duplicate registration", () => {
    const reg = getSystemTaskRegistry();
    reg.register("sleep-cycle", () => ({ status: "noop" }));
    expect(() => reg.register("sleep-cycle", () => ({ status: "noop" }))).toThrow(/already registered/);
  });

  it("unknown action is a visible failure — no fallthrough", async () => {
    const reg = getSystemTaskRegistry();
    // No handler registered for sleep-cycle
    const result = await reg.dispatch(systemEntry(), { progress: () => {}, signal: new AbortController().signal });
    expect(result.status).toBe("failed");
  });

  it("a throwing handler surfaces as failed", async () => {
    const reg = getSystemTaskRegistry();
    reg.register("sleep-cycle", () => { throw new Error("boom"); });
    const result = await reg.dispatch(systemEntry(), { progress: () => {}, signal: new AbortController().signal });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toContain("boom");
  });

  it("has() reflects registration", () => {
    const reg = getSystemTaskRegistry();
    expect(reg.has("sleep-cycle")).toBe(false);
    const dereg = reg.register("sleep-cycle", () => ({ status: "noop" }));
    expect(reg.has("sleep-cycle")).toBe(true);
    dereg();
    expect(reg.has("sleep-cycle")).toBe(false);
  });

  it("supports async handlers", async () => {
    const reg = getSystemTaskRegistry();
    reg.register("sleep-cycle", async () => {
      await new Promise<void>(r => setTimeout(r, 5));
      return { status: "noop" } as SystemTaskResult;
    });
    const result = await reg.dispatch(systemEntry(), { progress: () => {}, signal: new AbortController().signal });
    expect(result.status).toBe("noop");
  });

  it("rejects a non-system entry", async () => {
    const reg = getSystemTaskRegistry();
    reg.register("sleep-cycle", () => ({ status: "ok" }));
    const result = await reg.dispatch(systemEntry({ kind: "agent" }), { progress: () => {}, signal: new AbortController().signal });
    expect(result.status).toBe("failed");
  });
});
