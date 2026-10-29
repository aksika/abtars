/**
 * phase-pipeline-deps.test — memory-tool holder ordering + failure payloads.
 */
import { describe, it, expect, vi } from "vitest";
import { clearMemoryToolDependencies, createBootCtx } from "./context.js";
import { phasePipelineDeps, buildFailureNotification, skipSelfHealForDiagnostic } from "./phase-pipeline-deps.js";
import { makeTaskFailure } from "../components/tasks/task-failure.js";

function fakePiTransport() {
  return {
    getRuntimeStatus: () => ({ route: "pi-ai", provider: "x", model: "y" }),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as never;
}

function memoryState(state: "ready" | "disabled" | "unavailable") {
  return {
    state,
    supports: () => false,
  } as never;
}

describe("phasePipelineDeps memory composition (#1940 R1)", () => {
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

  it("#1940: no durable-context capability gate — memory readiness is decided at negotiation", async () => {
    const transport = fakePiTransport();
    const ctx = createBootCtx({
      transport,
      memoryRuntime: memoryState("ready"),
    });
    // The retired #1527 refusal is gone: a memory-enabled Pi route composes
    // without any durable-context capability. The phase proceeds into its
    // body (which needs a fully configured ctx and throws later on config),
    // and the transport is never destroyed by a capability refusal.
    await expect(phasePipelineDeps(ctx)).rejects.toThrow();
    expect(ctx.transport).not.toBeNull();
    expect((transport as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).not.toHaveBeenCalled();
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
    const event: import("../components/sha/sha-types.js").ScheduledFailureEvent = {
      source: "scheduled", entryId: "daily-ai", runId: "r1", taskKind: "agent", diagnostic, occurredAt: Date.now(),
    };
    const text = buildFailureNotification(event);
    expect(text).toContain("Daily Ai failed - supervision/lane_late_completion");
    expect(text).toContain("card 4");
    expect(text).toContain("contract c_ce252b756fd63a25e5551f8e");
    expect(text).toContain("overrun_ms 7485");
    expect(text).toContain("binding_limit max_duration_ms=120000");
    expect(text).toContain("Unevidenced criteria: c1");
    expect(text).not.toMatch(/[📥✅❌⏳🔧⚠️]/);
  });

  it("the admission notice is bounded and typed per outcome (#1688)", async () => {
    const { shaAdmissionNotice } = await import("../components/sha/sha-admission-notice.js");
    const event: import("../components/sha/sha-types.js").ScheduledFailureEvent = {
      source: "scheduled", entryId: "daily-ai", runId: "r1", taskKind: "agent", diagnostic, occurredAt: Date.now(),
    };
    expect(shaAdmissionNotice(event, { kind: "project_created", incidentId: 5, rootCardId: 9, mode: "full" })).toContain("incident #5");
    expect(shaAdmissionNotice(event, { kind: "attached", incidentId: 5, rootCardId: 9, occurrenceCount: 2 })).toContain("occurrence 2");
    expect(shaAdmissionNotice(event, { kind: "duplicate_event" })).toBeNull();
    expect(shaAdmissionNotice(event, { kind: "ignored", reason: "system" })).toContain("system-kind");
    expect(shaAdmissionNotice(event, { kind: "known_fix_started", incidentId: 7 })).toContain("known fix started");
  });
});

describe("failure cascade credits guard (#1297)", () => {
  const credits = makeTaskFailure("execution", "credits_exhausted", "executing", "All model candidates are blocked by provider credit exhaustion", "none");
  const other = makeTaskFailure("execution", "model_error", "executing", "provider down", "none");

  it("skipSelfHealForDiagnostic is true only for execution/credits_exhausted", () => {
    expect(skipSelfHealForDiagnostic(credits)).toBe(true);
    expect(skipSelfHealForDiagnostic(other)).toBe(false);
    // KNOWN_CODES scopes codes per category, so a mis-categorized match is
    // impossible by construction — the guard matches exact structured fields.
    expect(skipSelfHealForDiagnostic(makeTaskFailure("execution", "process_exit", "executing", "x", "none"))).toBe(false);
  });

  it("the single operator notification is enriched with the remediation ask for credits", () => {
    const event: import("../components/sha/sha-types.js").ScheduledFailureEvent = {
      source: "scheduled", entryId: "daily-ai", runId: "r1", taskKind: "agent", diagnostic: credits, occurredAt: Date.now(),
    };
    const text = buildFailureNotification(event);
    expect(text).toContain("execution/credits_exhausted");
    expect(text).toContain("Requires human intervention: restore provider credits, then run /models reset.");
    // Exactly one notification payload — the remediation is part of it, not a second message.
    expect(text.match(/\[warn\]/g)).toHaveLength(1);
  });

  it("non-credit failures keep the unchanged notification", () => {
    const event: import("../components/sha/sha-types.js").ScheduledFailureEvent = {
      source: "scheduled", entryId: "daily-ai", runId: "r1", taskKind: "agent", diagnostic: other, occurredAt: Date.now(),
    };
    const text = buildFailureNotification(event);
    expect(text).not.toContain("Requires human intervention");
  });
});
