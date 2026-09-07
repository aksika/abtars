import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The adapter module pulls the Spin singleton; cancel() never touches it
// (the supervisor is injected), so stub the module boundary.
vi.mock("./spin.js", () => ({
  spin: { getRunningCount: () => 0 },
}));

let TEST_HOME: string;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `adapter-cancel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

function seedAttempt(store: {
  insertAttempt(a: Record<string, unknown>): void;
}, id: string, cardId: number, ordinal: number, generation: number): void {
  store.insertAttempt({
    id, card_id: cardId, contract_id: "c_cancel_001",
    ordinal, executor_kind: "agent", executor_id: "spin-01",
    status: "running", started_at: "2026-09-07T00:00:00.000Z",
    generation,
  });
}

/**
 * #1778: adapter cancel reports into the attempt owner instead of writing a
 * durable verdict itself. A stale generation must never settle its successor.
 */
describe("SpinWorkerAdapter.cancel (#1778)", () => {
  it("settles cancellation through terminalSettlement and repeats idempotently", async () => {
    const { WorkerSupervisionStore } = await import("./worker-supervision-store.js");
    const { createExecutionSupervisor } = await import("./execution-control.js");
    const { SpinWorkerAdapter } = await import("./spin-worker-adapter.js");
    const store = new WorkerSupervisionStore();
    seedAttempt(store, "a_cancel_001", 901, 1, 1);

    const executions = createExecutionSupervisor({ maxConcurrent: {} });
    executions.open({ executionRef: "a_cancel_001:1", attemptId: "a_cancel_001", generation: 1, cardId: 901, type: "W" });
    const adapter = new SpinWorkerAdapter(undefined, executions);

    const claim = {
      attemptId: "a_cancel_001", cardId: 901, contractId: "c_cancel_001",
      executorKind: "agent" as const, executorId: "spin-01",
      generation: 1, claimedAt: "2026-09-07T00:00:00.000Z",
    };
    expect(await adapter.cancel(claim, "operator")).toMatchObject({ kind: "cancelled" });
    expect(store.getAttempt("a_cancel_001")?.lifecycle).toBe("cancelled");
    expect(await adapter.cancel(claim, "operator")).toMatchObject({ kind: "already_terminal", lifecycle: "cancelled" });
  });

  it("a stale generation reports the live owner and mutates no successor row", async () => {
    const { WorkerSupervisionStore } = await import("./worker-supervision-store.js");
    const { createExecutionSupervisor } = await import("./execution-control.js");
    const { SpinWorkerAdapter } = await import("./spin-worker-adapter.js");
    const store = new WorkerSupervisionStore();
    seedAttempt(store, "a_cancel_101", 902, 1, 1);

    // The old generation settled; the successor attempt is live.
    expect(store.terminalSettlement({
      attemptId: "a_cancel_101", expectedGeneration: 1,
      desiredState: "cancelled", stableReason: "test",
    }).kind).toBe("settled");
    seedAttempt(store, "a_cancel_102", 902, 2, 2);

    const executions = createExecutionSupervisor({ maxConcurrent: {} });
    executions.open({ executionRef: "a_cancel_101:1", attemptId: "a_cancel_101", generation: 1, cardId: 902, type: "W" });
    const adapter = new SpinWorkerAdapter(undefined, executions);

    const stale = await adapter.cancel({
      attemptId: "a_cancel_101", cardId: 902, contractId: "c_cancel_001",
      executorKind: "agent" as const, executorId: "spin-01",
      generation: 1, claimedAt: "2026-09-07T00:00:00.000Z",
    }, "operator");
    expect(stale.kind).toBe("already_terminal");
    // The successor generation is untouched by the stale cancel.
    expect(store.getAttempt("a_cancel_102")?.lifecycle).not.toBe("cancelled");
  });

  it("returns not_found for an unknown attempt", async () => {
    const { createExecutionSupervisor } = await import("./execution-control.js");
    const { SpinWorkerAdapter } = await import("./spin-worker-adapter.js");
    const executions = createExecutionSupervisor({ maxConcurrent: {} });
    const adapter = new SpinWorkerAdapter(undefined, executions);
    expect(await adapter.cancel({
      attemptId: "a_missing", cardId: 903, contractId: "c_cancel_001",
      executorKind: "agent" as const, executorId: "spin-01",
      generation: 1, claimedAt: "2026-09-07T00:00:00.000Z",
    }, "operator")).toMatchObject({ kind: "not_found" });
  });
});
