import { describe, it, expect } from "vitest";
import { filterCandidates, selectExecutor } from "./executor-selector.js";
import type { ExecutorCandidate } from "./executor-selector.js";

describe("executor-selector", () => {
  const candidates: ExecutorCandidate[] = [
    { id: "spin", kind: "agent", capabilities: ["*"], healthy: true, load: 0 },
    { id: "pi1", kind: "pi", capabilities: ["code", "browse"], healthy: true, load: 2 },
    { id: "remote1", kind: "remote", capabilities: ["code", "browse", "vision"], healthy: true, load: 5 },
    { id: "unhealthy1", kind: "agent", capabilities: ["*"], healthy: false, load: 0 },
  ];

  it("filters unhealthy candidates", () => {
    const { eligible, rejected } = filterCandidates(candidates, { requiredCapabilities: [] });
    expect(eligible).toHaveLength(3);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toContain("unhealthy");
  });

  it("filters by missing capabilities", () => {
    const { eligible } = filterCandidates(candidates, { requiredCapabilities: ["vision"] });
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.id).toBe("remote1");
  });

  it("wildcard capability matches all", () => {
    const { eligible } = filterCandidates(candidates, { requiredCapabilities: ["*"] });
    const healthy = eligible.filter(c => c.healthy);
    expect(healthy.length).toBeGreaterThanOrEqual(3);
  });

  it("filters excluded ids", () => {
    const { eligible } = filterCandidates(candidates, { requiredCapabilities: [], excludedIds: ["spin"] });
    expect(eligible.find(c => c.id === "spin")).toBeUndefined();
  });

  it("filters by locality", () => {
    const localCandidates: ExecutorCandidate[] = [
      { id: "spin", kind: "agent", capabilities: ["*"], healthy: true, locality: "local" },
      { id: "remote1", kind: "remote", capabilities: ["*"], healthy: true, locality: "remote" },
    ];
    const { eligible } = filterCandidates(localCandidates, { requiredCapabilities: [], requiredLocality: "local" });
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.id).toBe("spin");
  });

  it("selects executor preferring health and score", () => {
    const { selected } = selectExecutor(candidates, { requiredCapabilities: [] }, []);
    expect(selected).not.toBeNull();
    expect(selected!.id).toBe("spin"); // highest score (load 0 + wildcard)
  });

  it("respects preferred id", () => {
    const { selected, rationale } = selectExecutor(candidates, { requiredCapabilities: [], preferredId: "pi1" }, []);
    expect(selected!.id).toBe("pi1");
    expect(rationale.selectionStrategy).toBe("preferred");
  });

  it("penalizes previous failures", () => {
    const { selected } = selectExecutor(candidates, { requiredCapabilities: [] }, ["spin", "spin"]);
    expect(selected!.id).not.toBe("spin");
  });

  it("returns null when no eligible candidates", () => {
    const { selected, rationale } = selectExecutor([], { requiredCapabilities: [] }, []);
    expect(selected).toBeNull();
    expect(rationale.eligibleCount).toBe(0);
  });
});
