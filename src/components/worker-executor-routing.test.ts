/**
 * worker-executor-routing.test.ts — #1638: the one mechanical executor resolver.
 */
import { describe, it, expect } from "vitest";
import { resolveWorkerExecutorIntent } from "./worker-executor-routing.js";
import type { WorkerAcceptanceContractV1 } from "./worker-contract.js";

function makeContract(overrides: Partial<WorkerAcceptanceContractV1> = {}): WorkerAcceptanceContractV1 {
  return {
    schema_version: 1,
    id: "c_1",
    digest: "d",
    goal: "g",
    criteria: [{ id: "c1", description: "d" }],
    expected_artifacts: [],
    verification_commands: [],
    required_capabilities: [],
    limits: {},
    provenance: { root_card_id: 1, card_id: 2, authored_by: "t", created_at: "2026-01-01T00:00:00.000Z" },
    ...overrides,
  };
}

describe("resolveWorkerExecutorIntent (#1638)", () => {
  it("routes an alias contract to Pi with the canonical pi-coding id", () => {
    const intent = resolveWorkerExecutorIntent(makeContract({ workspace_alias: "repo-a" }));
    expect(intent).toEqual({ kind: "pi", id: "pi-coding", workspaceAlias: "repo-a" });
  });

  it("routes a no-alias contract to Spin with the canonical spin-local id", () => {
    const intent = resolveWorkerExecutorIntent(makeContract());
    expect(intent).toEqual({ kind: "agent", id: "spin-local" });
  });

  it("never activates Pi from goal text or capability strings", () => {
    const byGoal = resolveWorkerExecutorIntent(makeContract({ goal: "fix this repo with coding" }));
    const byCapability = resolveWorkerExecutorIntent(makeContract({ required_capabilities: ["pi-executor", "workspace:repo-a"] }));
    expect(byGoal.kind).toBe("agent");
    expect(byCapability.kind).toBe("agent");
  });
});
