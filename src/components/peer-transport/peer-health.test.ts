import { describe, it, expect, beforeEach, vi } from "vitest";
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

  // ── #1455: capability change subscriptions ───────────────────────────────

  it("subscribe notifies on register that changes effective values", () => {
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.register("host", ["bash"]);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).toContain("bash");
  });

  it("subscribe does not notify on register that adds no new values", () => {
    registry.register("host", ["bash"]);
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.register("other", ["bash"]); // same effective values (already present)
    expect(listener).not.toHaveBeenCalled();
  });

  it("subscribe notifies on disposer that changes effective values", () => {
    const dispose = registry.register("host", ["bash"]);
    const listener = vi.fn();
    registry.subscribe(listener);
    dispose();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).not.toContain("bash");
  });

  it("subscribe does not notify on disposer for registrations that didn't change values", () => {
    registry.register("host", ["bash"]);
    registry.register("other", ["bash"]);
    const listener = vi.fn();
    registry.subscribe(listener);
    // Dispose "other" — "bash" is still present via "host"
    const disposeOther = () => {
      const current = (registry as any).owners.get("other");
      if (current) (registry as any).owners.delete("other");
    };
    disposeOther();
    expect(listener).not.toHaveBeenCalled();
  });

  it("subscribe notifies on setHealth change (false -> true)", () => {
    registry.register("host", ["bash"]);
    registry.setHealth("host", false);
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.setHealth("host", true);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).toContain("bash");
  });

  it("subscribe does not notify on no-op setHealth (no effective change)", () => {
    registry.register("host", ["bash"]);
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.setHealth("host", true); // already healthy
    expect(listener).not.toHaveBeenCalled();
  });

  it("subscribe receives immutable frozen array", () => {
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.register("host", ["bash"]);
    const received = listener.mock.calls[0]![0];
    expect(Object.isFrozen(received)).toBe(true);
  });

  it("subscribe callback error does not block other listeners", () => {
    const throwing = vi.fn().mockImplementation(() => { throw new Error("boom"); });
    const ok = vi.fn();
    registry.subscribe(throwing);
    registry.subscribe(ok);
    registry.register("host", ["bash"]);
    expect(throwing).toHaveBeenCalled();
    expect(ok).toHaveBeenCalled();
  });

  it("subscribe returns disposer that removes listener", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsub = registry.subscribe(a);
    registry.subscribe(b);
    unsub();
    registry.register("host", ["bash"]);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it("subscribe is not called for registrations before subscription", () => {
    const listener = vi.fn();
    registry.register("host", ["bash"]);
    registry.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
  });
});
