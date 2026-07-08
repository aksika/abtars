/**
 * boot-graph.ts — parallel dependency-graph boot dispatcher (#944).
 *
 * Each subsystem declares its deps and runs as soon as deps are satisfied.
 * Failure of one branch never blocks unrelated branches.
 */

import { logInfo, logWarn, logTrace } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";

export interface BootNode {
  name: string;
  deps: string[];
  optionalDeps?: string[];
  run: (ctx: BootCtx) => Promise<PhaseResult | void>;
  optional: boolean;
}

export type BootStatus = "ok" | "failed" | "skipped";
export type BootReport = Map<string, { status: BootStatus; ms?: number; error?: string; blockedBy?: string }>;

export async function bootGraph(nodes: BootNode[], ctx: BootCtx): Promise<BootReport> {
  const resolved = new Map<string, Promise<void>>();
  const report: BootReport = new Map();
  const nodeMap = new Map(nodes.map(n => [n.name, n]));
  const t0Global = Date.now();
  logTrace("boot", `bootGraph: starting ${nodes.length} nodes [${nodes.map(n => n.name).join(", ")}]`);

  function resolve(node: BootNode): Promise<void> {
    if (resolved.has(node.name)) return resolved.get(node.name)!;
    const p = (async () => {
      logTrace("boot", `${node.name}: waiting for deps [${node.deps.join(", ") || "none"}]`);
      for (const dep of node.deps) {
        const depNode = nodeMap.get(dep);
        if (!depNode) throw new Error(`Boot node "${node.name}" depends on unknown node "${dep}"`);
        await resolve(depNode);
        const depStatus = report.get(dep);
        if (depStatus && depStatus.status !== "ok") {
          report.set(node.name, { status: "skipped", blockedBy: dep });
          logTrace("boot", `${node.name}: dep "${dep}" status=${depStatus.status} — skipping`);
          logWarn("boot", `» ${node.name} skipped (blocked by ${dep})`);
          return;
        }
      }
      if (node.optionalDeps?.length) {
        logTrace("boot", `${node.name}: waiting for optional deps [${node.optionalDeps.join(", ")}]`);
      }
      for (const dep of node.optionalDeps ?? []) {
        const depNode = nodeMap.get(dep);
        if (depNode) await resolve(depNode).catch(() => {});
      }
      const t0 = Date.now();
      logTrace("boot", `${node.name}: deps satisfied, executing (optional=${node.optional})`);
      try {
        await node.run(ctx);
        const ms = Date.now() - t0;
        report.set(node.name, { status: "ok", ms });
        logInfo("boot", `✓ ${node.name} (${ms}ms)`);
      } catch (err: any) {
        const ms = Date.now() - t0;
        report.set(node.name, { status: "failed", ms, error: err.message });
        logTrace("boot", `${node.name}: threw after ${ms}ms — ${err.message}`);
        if (!node.optional) throw err;
        logWarn("boot", `✗ ${node.name} failed (${ms}ms): ${err.message} — continuing`);
      }
    })();
    resolved.set(node.name, p);
    return p;
  }

  await Promise.allSettled(nodes.map(n => resolve(n)));
  logTrace("boot", `bootGraph: complete in ${Date.now() - t0Global}ms — ${[...report].filter(([,v]) => v.status === "ok").length} ok, ${[...report].filter(([,v]) => v.status === "failed").length} failed, ${[...report].filter(([,v]) => v.status === "skipped").length} skipped`);
  // Mutate in place — DO NOT reassign ctx.phaseHealth. PipelineDeps captures the reference at
  // boot time; reassigning here would leave all command handlers reading the original empty Map.
  ctx.phaseHealth.clear();
  for (const [k, v] of report) {
    ctx.phaseHealth.set(k, { status: v.status === "ok" ? "ok" : v.status, error: v.error ?? v.blockedBy });
  }
  return report;
}

/** Detect cycles in the boot graph. Returns first cycle found or null. */
export function detectCycle(nodes: BootNode[]): string[] | null {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const nodeMap = new Map(nodes.map(n => [n.name, n]));

  function dfs(name: string, path: string[]): string[] | null {
    if (stack.has(name)) return [...path, name];
    if (visited.has(name)) return null;
    visited.add(name);
    stack.add(name);
    const node = nodeMap.get(name);
    if (node) {
      for (const dep of [...node.deps, ...(node.optionalDeps ?? [])]) {
        const cycle = dfs(dep, [...path, name]);
        if (cycle) return cycle;
      }
    }
    stack.delete(name);
    return null;
  }

  for (const node of nodes) {
    const cycle = dfs(node.name, []);
    if (cycle) return cycle;
  }
  return null;
}
