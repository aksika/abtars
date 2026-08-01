/**
 * phase-pipeline-deps.test — #1527 context-blind refusal.
 *
 * A memory-enabled Pi route that negotiated no durable-context capability is
 * context-blind by construction. The composition point must refuse it instead
 * of letting durable requests degrade to suffix-only answers.
 */
import { describe, it, expect, vi } from "vitest";
import { createBootCtx } from "./context.js";
import { phasePipelineDeps } from "./phase-pipeline-deps.js";

function fakePiTransport() {
  return {
    getRuntimeStatus: () => ({ route: "pi-ai", provider: "x", model: "y" }),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function fakeAcpTransport() {
  return {
    getRuntimeStatus: () => ({ route: "acp", provider: "x", model: "y" }),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function memoryState(state: "ready" | "disabled" | "unavailable", supportsDurable: boolean) {
  return {
    state,
    supports: (cap: string) => cap === "durableContext" ? supportsDurable : false,
  } as never;
}

describe("phasePipelineDeps #1527", () => {
  it("refuses a memory-enabled Pi route without the durable-context capability", async () => {
    const ctx = createBootCtx({
      transport: fakePiTransport(),
      memoryRuntime: memoryState("ready", false),
    });
    const result = await phasePipelineDeps(ctx);

    expect(result).toBe("skipped");
    expect(ctx.transport).toBeNull();
    expect(ctx.phaseHealth.get("phasePipelineDeps")).toMatchObject({ status: "failed" });
  });

  it("does not refuse when the Pi route negotiated the durable-context capability", async () => {
    const ctx = createBootCtx({
      transport: fakePiTransport(),
      memoryRuntime: memoryState("ready", true),
    });
    // The refusal gate is passed; execution continues into the phase body,
    // which needs a fully configured ctx. The assertion below proves the gate
    // did not destroy the transport (the phase will throw later on config).
    await expect(phasePipelineDeps(ctx)).rejects.toThrow();
    expect(ctx.transport).not.toBeNull();
  });

  it("does not refuse non-Pi routes when memory lacks the capability", async () => {
    const ctx = createBootCtx({
      transport: fakeAcpTransport(),
      memoryRuntime: memoryState("ready", false),
    });
    await expect(phasePipelineDeps(ctx)).rejects.toThrow();
    expect(ctx.transport).not.toBeNull();
    expect((ctx.transport as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).not.toHaveBeenCalled();
  });
});
