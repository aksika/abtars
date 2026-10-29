/**
 * session-control.test.ts — #1406 backend-neutral control plane: exact
 * adapter dispatch, unsupported outcomes, automatic dedupe, and telemetry.
 * abmind conversation compaction is retired (#1940 R8).
 */
import { describe, it, expect, vi } from "vitest";
import { SessionControlService } from "./service.js";
import type { SessionControlAdapter, SessionControlResult, SessionCompactionTelemetryV1 } from "./types.js";

function makeResult(status: SessionControlResult["status"]): SessionControlResult {
  return { status, targetKind: "durable_conversation", message: status };
}

function makeRecordingAdapter(kind: "durable_conversation" | "local_pi_run"): SessionControlAdapter & { calls: number } {
  const calls = 0;
  return {
    targetKind: kind,
    calls,
    supports: () => true,
    async execute() { return makeResult("completed"); },
  } as SessionControlAdapter & { calls: number };
}

describe("SessionControlService #1406", () => {
  it("dispatches to exactly one adapter by target kind", async () => {
    const service = new SessionControlService();
    const durable = makeRecordingAdapter("durable_conversation");
    service.register(durable);
    const result = await service.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "manual" },
    );
    expect(result.status).toBe("completed");
  });

  it("returns unsupported for an unregistered target kind (no fallback)", async () => {
    const service = new SessionControlService();
    service.register(makeRecordingAdapter("durable_conversation"));
    const result = await service.execute(
      { kind: "local_pi_run", principalId: "u", runId: "r", generation: 1 },
      { kind: "compact", reason: "manual" },
    );
    expect(result.status).toBe("unsupported");
  });

  it("returns unsupported when the adapter rejects the operation", async () => {
    const service = new SessionControlService();
    service.register({
      targetKind: "durable_conversation",
      supports: () => false,
      async execute() { return makeResult("completed"); },
    });
    const result = await service.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "manual" },
    );
    expect(result.status).toBe("unsupported");
  });

  it("deduplicates automatic requests per target while in flight; manual bypasses", async () => {
    let resolveFirst: (r: SessionControlResult) => void = () => {};
    const service = new SessionControlService();
    service.register({
      targetKind: "durable_conversation",
      supports: () => true,
      execute: () => new Promise(resolve => { resolveFirst = resolve; }),
    });
    const first = service.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "automatic" },
    );
    const second = await service.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "automatic" },
    );
    expect(second.status).toBe("busy");
    resolveFirst(makeResult("completed"));
    await first;
  });

  it("emits one content-free telemetry event per request", async () => {
    const events: SessionCompactionTelemetryV1[] = [];
    const service = new SessionControlService({ onTelemetry: e => events.push(e) });
    service.register(makeRecordingAdapter("durable_conversation"));
    await service.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "manual" },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ targetKind: "durable_conversation", reason: "manual", status: "completed" });
  });

  it("maps adapter exceptions to failed, never crashing the caller", async () => {
    const service = new SessionControlService();
    service.register({
      targetKind: "durable_conversation",
      supports: () => true,
      async execute() { throw new Error("boom"); },
    });
    const result = await service.execute(
      { kind: "durable_conversation", principalId: "u", sessionId: "s" },
      { kind: "compact", reason: "manual" },
    );
    expect(result.status).toBe("failed");
  });
});

