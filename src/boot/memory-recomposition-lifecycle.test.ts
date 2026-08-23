/**
 * memory-recomposition-lifecycle.test — #1706 boot-boundary regression.
 *
 * Proves against the REAL bootGraph + phaseMemory + supervisor:
 * 1. a recoverable initial composition failure records the optional `memory`
 *    node as failed and SURVIVES graph finalization (no lost update);
 * 2. retries are not armed while the graph runs (start() happens post-graph);
 * 3. a post-graph late success flips the SAME ctx.phaseHealth map to ok and
 *    upgrades the facade consumers already captured.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockLoadAbmind = vi.hoisted(() => vi.fn());
vi.mock("../utils/abmind-lazy.js", () => ({
  loadAbmind: mockLoadAbmind,
}));

vi.mock("../components/logger.js", () => ({
  logDebug: vi.fn(),
  logTrace: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { bootGraph, type BootNode } from "./boot-graph.js";
import { createBootCtx } from "./context.js";
import { phaseMemory } from "./phase-memory.js";
import { AbmindEndpointConfigError } from "../components/abmind-endpoint-config.js";
import type { BootCtx } from "./context.js";

let testHome = "";
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function ctxWithMemory(enabled: boolean): BootCtx {
  return createBootCtx({
    memoryConfig: { memoryEnabled: enabled, memoryDir: "/tmp" } as never,
  });
}

describe("#1706 boot-boundary: recomposition vs graph finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadAbmind.mockReset();
    testHome = mkdtempSync(join(tmpdir(), "abtars-recomp-lifecycle-"));
    mkdirSync(join(testHome, "config"), { recursive: true });
    process.env["ABTARS_HOME"] = testHome;
  });

  afterEach(() => {
    delete process.env["ABTARS_HOME"];
    rmSync(testHome, { recursive: true, force: true });
  });

  it("initial failure survives finalization; post-graph retry flips the same health map to ok", async () => {
    let resolveCalls = 0;
    const resolveEndpoint = vi.fn(() => {
      resolveCalls++;
      if (resolveCalls === 1) throw new AbmindEndpointConfigError("missing", "endpoint config not written yet");
      return { mode: "local" as const, source: "default" as const };
    });
    const fakeModule = { getMemoryClient: vi.fn().mockResolvedValue({
      capabilities: {
        version: 1,
        methods: ["private.recall"],
        features: { private_read: "true" },
      },
      privateMemory: {},
      negotiate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }) };
    mockLoadAbmind.mockResolvedValue(fakeModule);

    const queue: Array<() => void> = [];
    const schedule = (fn: () => void): (() => void) => {
      queue.push(fn);
      return () => {};
    };

    const ctx = ctxWithMemory(true);
    const nodes: BootNode[] = [
      { name: "memory", deps: [], optional: true, run: c => phaseMemory(c, { resolveEndpoint, schedule }) },
      // facade consumer: awaits memory optionally, runs even when it fails
      { name: "facadeConsumer", deps: [], optionalDeps: ["memory"], optional: true, run: async () => {} },
    ];

    await bootGraph(nodes, ctx);

    // 1. finalized degraded health survived bootGraph finalization
    expect(ctx.phaseHealth.get("memory")?.status).toBe("failed");
    expect(ctx.phaseHealth.get("memory")?.error).toContain("config_invalid");
    // facade consumer was NOT skipped by the failed optional dependency
    expect(ctx.phaseHealth.get("facadeConsumer")?.status).toBe("ok");
    expect(resolveCalls).toBe(1);
    // 2. no retry timer armed while the graph ran
    expect(queue).toHaveLength(0);
    expect(ctx.memoryRuntime.state).toBe("unavailable");

    // startBridge equivalent: arm retries only now
    ctx.memoryRecomposition!.start();
    expect(queue).toHaveLength(1);
    queue[0]!();
    await flush();
    await flush();

    // 3. same map instance flipped to ok; same facade upgraded
    expect(ctx.memoryRuntime.state).toBe("ready");
    expect(ctx.phaseHealth.get("memory")?.status).toBe("ok");
    expect(ctx.memoryRecomposition!.diagnostics.attempts).toBe(2);
  });

  it("a fully healthy boot leaves no supervisor and reports ok", async () => {
    const fakeModule = { getMemoryClient: vi.fn().mockResolvedValue({
      capabilities: { version: 1, methods: ["private.recall"], features: { private_read: "true" } },
      privateMemory: {},
      negotiate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    }) };
    mockLoadAbmind.mockResolvedValue(fakeModule);

    const queue: Array<() => void> = [];
    const schedule = (fn: () => void): (() => void) => {
      queue.push(fn);
      return () => {};
    };

    const ctx = ctxWithMemory(true);
    const nodes: BootNode[] = [
      { name: "memory", deps: [], optional: true, run: c => phaseMemory(c, { schedule }) },
    ];

    await bootGraph(nodes, ctx);

    expect(ctx.phaseHealth.get("memory")?.status).toBe("ok");
    expect(ctx.memoryRuntime.state).toBe("ready");
    expect(ctx.memoryRecomposition).toBeNull();
    expect(queue).toHaveLength(0);
  });
});
