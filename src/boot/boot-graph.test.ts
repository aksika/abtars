import { describe, expect, it } from "vitest";
import { bootGraph, detectCycle, type BootNode } from "./boot-graph.js";
import { createBootCtx } from "./context.js";

function node(name: string, deps: string[] = [], optional = true, optionalDeps?: string[]): BootNode {
  return { name, deps, optionalDeps, optional, run: async () => {} };
}

function failNode(name: string, deps: string[] = [], optional = true): BootNode {
  return { name, deps, optional, run: async () => { throw new Error(`${name} broke`); } };
}

describe("bootGraph", () => {
  it("runs all nodes with no deps in parallel", async () => {
    const order: string[] = [];
    const nodes: BootNode[] = [
      { name: "a", deps: [], optional: true, run: async () => { order.push("a"); } },
      { name: "b", deps: [], optional: true, run: async () => { order.push("b"); } },
      { name: "c", deps: [], optional: true, run: async () => { order.push("c"); } },
    ];
    const report = await bootGraph(nodes, createBootCtx());
    expect(order).toHaveLength(3);
    expect(report.get("a")!.status).toBe("ok");
    expect(report.get("b")!.status).toBe("ok");
    expect(report.get("c")!.status).toBe("ok");
  });

  it("failure of optional node → dependents skipped", async () => {
    const nodes: BootNode[] = [
      failNode("memory", [], true),
      node("sleep", ["memory"]),
    ];
    const report = await bootGraph(nodes, createBootCtx());
    expect(report.get("memory")!.status).toBe("failed");
    expect(report.get("sleep")!.status).toBe("skipped");
    expect(report.get("sleep")!.blockedBy).toBe("memory");
  });

  it("failure of required node → error in report, dependents skipped", async () => {
    const nodes: BootNode[] = [
      failNode("config", [], false),
      node("transport", ["config"]),
    ];
    const report = await bootGraph(nodes, createBootCtx());
    expect(report.get("config")!.status).toBe("failed");
    // transport either skipped or never reached (both acceptable — config is fatal)
    const transport = report.get("transport");
    if (transport) expect(transport.status).toBe("skipped");
  });

  it("optional deps don't block on failure", async () => {
    const ran: string[] = [];
    const nodes: BootNode[] = [
      failNode("memory", [], true),
      { name: "pipeline", deps: [], optionalDeps: ["memory"], optional: true, run: async () => { ran.push("pipeline"); } },
    ];
    const report = await bootGraph(nodes, createBootCtx());
    expect(report.get("pipeline")!.status).toBe("ok");
    expect(ran).toContain("pipeline");
  });

  it("respects dependency order", async () => {
    const order: string[] = [];
    const nodes: BootNode[] = [
      { name: "a", deps: [], optional: true, run: async () => { await new Promise(r => setTimeout(r, 10)); order.push("a"); } },
      { name: "b", deps: ["a"], optional: true, run: async () => { order.push("b"); } },
    ];
    await bootGraph(nodes, createBootCtx());
    expect(order).toEqual(["a", "b"]);
  });

  it("reports timing in ms", async () => {
    const nodes: BootNode[] = [
      { name: "slow", deps: [], optional: true, run: async () => { await new Promise(r => setTimeout(r, 20)); } },
    ];
    const report = await bootGraph(nodes, createBootCtx());
    expect(report.get("slow")!.ms).toBeGreaterThanOrEqual(15);
  });
});

describe("detectCycle", () => {
  it("returns null for acyclic graph", () => {
    expect(detectCycle([node("a"), node("b", ["a"]), node("c", ["b"])])).toBeNull();
  });

  it("detects direct cycle", () => {
    const cycle = detectCycle([node("a", ["b"]), node("b", ["a"])]);
    expect(cycle).not.toBeNull();
  });

  it("detects indirect cycle", () => {
    const cycle = detectCycle([node("a", ["c"]), node("b", ["a"]), node("c", ["b"])]);
    expect(cycle).not.toBeNull();
  });
});
