/**
 * phase-pipeline-deps.test — #1527 context-blind refusal.
 *
 * A memory-enabled Pi route that negotiated no durable-context capability is
 * context-blind by construction. The composition point must refuse it instead
 * of letting durable requests degrade to suffix-only answers.
 */
import { describe, it, expect, vi } from "vitest";
import { clearMemoryToolDependencies, createBootCtx } from "./context.js";
import { phasePipelineDeps, buildFailureNotification, buildShaFailurePrompt } from "./phase-pipeline-deps.js";
import { makeTaskFailure } from "../components/tasks/task-failure.js";

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
  it("clears the holder before closing the old quota", () => {
    const ctx = createBootCtx();
    const order: string[] = [];

    ctx.memoryToolDependencies.current = {
      runtime: {} as never,
      quota: {} as never,
    };
    ctx.memoryStoreQuota = {
      close: () => {
        order.push(ctx.memoryToolDependencies.current === null ? "cleared" : "stale");
      },
    } as never;

    clearMemoryToolDependencies(ctx);

    expect(order).toEqual(["cleared"]);
    expect(ctx.memoryToolDependencies.current).toBeNull();
    expect(ctx.memoryStoreQuota).toBeNull();
  });

  it("refuses a memory-enabled Pi route without the durable-context capability", async () => {
    const ctx = createBootCtx({
      transport: fakePiTransport(),
      memoryRuntime: memoryState("ready", false),
    });
    // The refusal must THROW: bootGraph marks any non-throwing phase "ok" and
    // replaces phaseHealth with its report, so a skipped return would let
    // downstream nodes boot against a null pipelineDeps.
    await expect(phasePipelineDeps(ctx)).rejects.toThrow(/durable context capability/);
    expect(ctx.transport).toBeNull();
    expect((ctx.transport as unknown as { destroy: ReturnType<typeof vi.fn> } | null)).toBeNull();
  });

  it("destroys the refused transport", async () => {
    const transport = fakePiTransport();
    const ctx = createBootCtx({
      transport,
      memoryRuntime: memoryState("ready", false),
    });
    await expect(phasePipelineDeps(ctx)).rejects.toThrow();
    expect(transport.destroy).toHaveBeenCalledTimes(1);
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

describe("failure cascade payloads (#1588)", () => {
  const diagnostic = makeTaskFailure("supervision", "lane_late_completion", "executing", "late", "none", {
    rootCardId: 7,
    lanes: [{
      cardId: 4,
      contractId: "c_ce252b756fd63a25e5551f8e",
      attemptId: "a_xyz",
      lifecycle: "timed_out",
      cancelReason: "late_completion_timed_out: worker_completed",
      hardDeadlineAt: "2026-08-06T13:46:38.195Z",
      settledAt: "2026-08-06T13:46:45.680Z",
      overrunMs: 7485,
      bindingLimit: { name: "max_duration_ms", value: 120000 },
      criteria: [{ id: "c1", status: "not_run" }],
      missingEvidence: ["c1"],
    }],
  });

  it("the operator notification carries category/code and the lane facts", () => {
    const text = buildFailureNotification("daily-ai", diagnostic);
    expect(text).toContain("Daily Ai failed - supervision/lane_late_completion");
    expect(text).toContain("card 4");
    expect(text).toContain("contract c_ce252b756fd63a25e5551f8e");
    expect(text).toContain("overrun_ms 7485");
    expect(text).toContain("binding_limit max_duration_ms=120000");
    expect(text).toContain("Unevidenced criteria: c1");
    expect(text).not.toMatch(/[📥✅❌⏳🔧⚠️]/);
  });

  it("the SHA prompt carries the structured root cause and preserves the FORBIDDEN block", () => {
    const text = buildShaFailurePrompt("daily-ai", diagnostic, "");
    expect(text).toContain('Task: "daily-ai"   Category: supervision/lane_late_completion');
    expect(text).toContain("<root-cause>");
    expect(text).toContain('cancel-reason="late_completion_timed_out: worker_completed"');
    expect(text).toContain('hard-deadline="2026-08-06T13:46:38.195Z"');
    expect(text).toContain('settled="2026-08-06T13:46:45.680Z"');
    expect(text).toContain('overrun-ms="7485"');
    expect(text).toContain('binding-limit="max_duration_ms=120000"');
    expect(text).toContain('<criterion id="c1" status="not_run" evidence="none"/>');
    expect(text).toContain("Permitted remediation: task_manage action=adjust (bounded) or action=escalate.");
    expect(text).toContain("FORBIDDEN: Do NOT modify vital config files unless the bridge is in a crash loop or cannot boot:");
    expect(text).toContain("- transport.json\n- .env / .env.skills\n- peers.json\n- users.json");
    expect(text).toContain("A single task failure is NOT grounds for config changes.");
  });

  it("a pending failure list is preserved in the SHA prompt", () => {
    const text = buildShaFailurePrompt("daily-ai", diagnostic, "\nAlso failed recently: finance-daily");
    expect(text).toContain("Also failed recently: finance-daily");
  });
});
