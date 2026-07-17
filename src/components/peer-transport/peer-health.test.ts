import { describe, it, expect, beforeEach } from "vitest";
import { CapabilityRegistry, resetHealthStore } from "./peer-health.js";

describe("CapabilityRegistry", () => {
  let registry: CapabilityRegistry;

  beforeEach(() => {
    registry = new CapabilityRegistry();
  });

  it("register returns values from getValues", () => {
    registry.register("host", ["bash", "node"]);
    const values = registry.getValues();
    expect(values).toContain("bash");
    expect(values).toContain("node");
  });

  it("register disposer removes values", () => {
    const dispose = registry.register("host", ["bash"]);
    dispose();
    expect(registry.getValues()).not.toContain("bash");
  });

  it("setHealth false hides values", () => {
    registry.register("host", ["bash"]);
    registry.setHealth("host", false);
    expect(registry.getValues()).not.toContain("bash");
  });

  it("setHealth true re-shows values", () => {
    registry.register("host", ["bash"]);
    registry.setHealth("host", false);
    registry.setHealth("host", true);
    expect(registry.getValues()).toContain("bash");
  });

  it("deduplicates values across owners", () => {
    registry.register("a", ["bash"]);
    registry.register("b", ["bash"]);
    const values = registry.getValues().filter(v => v === "bash");
    expect(values).toHaveLength(1);
  });

  it("sorts values alphabetically", () => {
    registry.register("a", ["z", "a", "m"]);
    const values = registry.getValues();
    expect(values).toEqual(["a", "m", "z"]);
  });

  it("capped at 64 values", () => {
    const many = Array.from({ length: 100 }, (_, i) => `cap${i}`);
    registry.register("host", many);
    expect(registry.getValues().length).toBeLessThanOrEqual(64);
  });

  it("resetHealthStore clears singleton", () => {
    const r2 = new CapabilityRegistry();
    r2.register("host", ["bash"]);
    resetHealthStore();
    const fresh = new CapabilityRegistry();
    expect(fresh.getValues()).not.toContain("bash");
  });
});
