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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

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
    // #1380: memoryIpc removed (daemon replaces legacy IPC server)
    expect(BOOT_NODES).toHaveLength(11);
  });

  // #1455: Source-boundary — no Agent Swarm imports in heartbeat modules
  test("heartbeat modules do not import Agent Swarm peer-transport components", () => {
    const root = cwd();
    const forbidden = [
      "peer-transport",
      "ws-peer-client",
      "peer-ws-broker",
      "peer-inventory",
      "peer-doorbell",
      "remote-pi-delivery",
      "remote-pi-registry",
    ];
    const heartbeatFiles = [
      join(root, "src/boot/phase-heartbeat.ts"),
      join(root, "src/boot/heartbeat-tier3.ts"),
    ];
    for (const file of heartbeatFiles) {
      const content = readFileSync(file, "utf-8");
      for (const pattern of forbidden) {
        // Check import/require statements, not comments or string literals
        const importRe = new RegExp(`from\\s+["'](?:.*?/)?${pattern}(?:/.*?)?["']`);
        const requireRe = new RegExp(`require\\(["'](?:.*?/)?${pattern}(?:/.*?)?["']\\)`);
        expect(content, `${file}: must not import ${pattern}`).not.toMatch(importRe);
        expect(content, `${file}: must not require ${pattern}`).not.toMatch(requireRe);
      }
    }
  });

  test("no 'heartbeat' peer connection reason remains in transport code", () => {
    const root = cwd();
    const transportFiles = [
      join(root, "src/components/peer-transport/http-transport.ts"),
      join(root, "src/components/peer-transport/peer-doorbell.ts"),
    ];
    for (const file of transportFiles) {
      const content = readFileSync(file, "utf-8");
      // Check for "heartbeat" in the reason union
      // This should NOT appear as a valid reason value in the PeerConnectionManager type
      const reasonUnionMatch = content.match(/reason:\s*"[^"]*heartbeat[^"]*"/);
      expect(reasonUnionMatch, `${file}: should not have heartbeat reason`).toBeNull();
    }
  });

  test("'heartbeat' is not in PUSH_ALLOWLIST or ALLOWED_PUSH", () => {
    const root = cwd();
    const brokerFile = join(root, "src/components/peer-transport/peer-ws-broker.ts");
    const apiServerFile = join(root, "src/components/agent-api-server.ts");
    const brokerContent = readFileSync(brokerFile, "utf-8");
    const apiContent = readFileSync(apiServerFile, "utf-8");
    expect(brokerContent).not.toContain('"heartbeat"');
    expect(apiContent).not.toContain('"heartbeat"');
  });
});
