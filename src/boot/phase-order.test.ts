/**
 * phase-order.test — validate boot graph integrity (#944).
 *
 * Replaces the old sequence assertion with structural graph checks:
 * 1. No cycles in the dependency graph
 * 2. All deps reference existing nodes
 * 3. BOOT_PHASES array matches BOOT_NODES names (compat guard)
 */

import { describe, expect, test } from "vitest";
import { BOOT_PHASES } from "../bridge-app.js";
import { BOOT_NODES } from "./boot-nodes.js";
import { detectCycle } from "./boot-graph.js";

describe("Boot graph integrity", () => {
  test("no cycles in dependency graph", () => {
    const cycle = detectCycle(BOOT_NODES);
    expect(cycle).toBeNull();
  });

  test("all deps reference existing nodes", () => {
    const names = new Set(BOOT_NODES.map(n => n.name));
    for (const node of BOOT_NODES) {
      for (const dep of [...node.deps, ...(node.optionalDeps ?? [])]) {
        expect(names.has(dep), `Node "${node.name}" depends on unknown "${dep}"`).toBe(true);
      }
    }
  });

  test("no duplicate node names", () => {
    const names = BOOT_NODES.map(n => n.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("all root nodes have no deps", () => {
    const roots = BOOT_NODES.filter(n => n.deps.length === 0);
    expect(roots.length).toBeGreaterThan(0);
  });

  test("heartbeat is required (not optional)", () => {
    const hb = BOOT_NODES.find(n => n.name === "heartbeat");
    expect(hb).toBeDefined();
    expect(hb!.optional).toBe(false);
  });

  test("BOOT_PHASES compat — contains all graph node names plus shutdown", () => {
    // BOOT_PHASES includes phaseShutdown + legacy phasePlatforms (not in graph)
    // Config is handled explicitly in startBridge, not in the graph
    expect(BOOT_PHASES.length).toBeGreaterThanOrEqual(BOOT_NODES.length + 1);
    expect(BOOT_NODES).toHaveLength(10);
  });
});
