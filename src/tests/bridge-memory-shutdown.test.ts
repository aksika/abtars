/**
 * bridge-memory-shutdown.test — #1706 Task 6 shutdown precedence.
 *
 * Proves against a REAL Bridge instance: an in-flight late composition that
 * succeeds DURING shutdown is disposed (client closed once), never published,
 * leaves the facade unavailable, and the memory-recomposition drain step
 * completes before the memory close step.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../components/logger.js", () => ({
  logDebug: vi.fn(),
  logTrace: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const mockLoadAbmind = vi.hoisted(() => vi.fn());
vi.mock("../utils/abmind-lazy.js", () => ({
  loadAbmind: mockLoadAbmind,
}));

// Bridge.shutdown touches these via require()/import() — keep them inert.
vi.mock("../components/runtime-health-snapshot.js", () => ({
  initSnapshot: vi.fn(),
  removeSnapshot: vi.fn(),
}));
vi.mock("../components/peer-transport/index.js", () => ({
  getPeerTransport: vi.fn(() => ({})),
}));
vi.mock("../components/usage-tracker.js", () => ({
  flushUsage: vi.fn(),
}));
vi.mock("../components/cache-telemetry.js", () => ({
  flushCacheTelemetry: vi.fn(),
  pruneCacheTelemetryFile: vi.fn(),
}));

import { Bridge } from "../bridge-app.js";
import { createBootCtx } from "../boot/context.js";
import { phaseMemory } from "../boot/phase-memory.js";
import { createClientRuntime } from "../components/memory-runtime.js";
import type { BootCtx } from "../boot/context.js";

let testHome = "";

describe("#1706 shutdown precedence over late composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testHome = mkdtempSync(join(tmpdir(), "abtars-bridge-shutdown-"));
    mkdirSync(join(testHome, "config"), { recursive: true });
    process.env["ABTARS_HOME"] = testHome;
  });

  afterEach(() => {
    delete process.env["ABTARS_HOME"];
    rmSync(testHome, { recursive: true, force: true });
  });

  it("drains an in-flight success: client closed exactly once by dispose, never published, facade stays unavailable", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const negotiatedClient = {
      capabilities: { version: 1, methods: ["private.recall"], features: { private_read: "true" } },
      privateMemory: {},
      negotiate: vi.fn(async () => { order.push("negotiate"); }),
      close: vi.fn(async () => { order.push("client-close"); }),
    };

    const calls = 0;
    void calls;
    let createCalls = 0;
    const createRuntime = vi.fn(async () => {
      createCalls++;
      if (createCalls === 1) {
        throw new Error("connection failed: ECONNREFUSED");
      }
      await gate;
      const runtime = createClientRuntime(negotiatedClient as never);
      return { mode: "local" as const, client: negotiatedClient as never, runtime, abmindModule: null };
    });

    const queue: Array<() => void> = [];
    const schedule = (fn: () => void): (() => void) => {
      queue.push(fn);
      return () => {};
    };

    const ctx: BootCtx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: join(testHome, "memory") } as never,
    });
    mockLoadAbmind.mockResolvedValue(null); // no global package — factory path bypassed by injected createRuntime

    await expect(phaseMemory(ctx, { createRuntime, schedule })).rejects.toThrow(/composition pending/);
    const facade = ctx.memoryRuntime;

    // Make the facade's own close observable for the ordering proof.
    vi.spyOn(facade, "close").mockImplementation(async () => { order.push("facade-close"); });

    // Post-graph start (startBridge equivalent), then fire the first retry —
    // it hangs on the negotiation gate.
    ctx.memoryRecomposition!.start();
    queue[0]!();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(createCalls).toBe(2);

    // Shutdown races the in-flight success.
    const bridge = new Bridge(ctx);
    const exitPromise = bridge.waitForExit();
    bridge.requestShutdown(0);

    // Wait until the drain step has MARKED cancellation (it is now awaiting
    // the in-flight attempt), then let the negotiation succeed.
    await vi.waitFor(() => {
      if (ctx.memoryRecomposition!.diagnostics.state !== "cancelled") {
        throw new Error("recomposition drain has not started");
      }
    });

    release();
    await exitPromise;

    expect(order.filter(e => e === "client-close")).toHaveLength(1); // dispose closed it…
    expect(order.indexOf("client-close")).toBeLessThan(order.indexOf("facade-close")); // …before memory close
    expect((facade as unknown as { state: string }).state).toBe("unavailable");       // never published
    expect(ctx.memoryRecomposition).toBeNull();                                       // drained slot
  });

  it("the memory close step runs through the facade without a live supervisor", async () => {
    const facadeCloseOrder: string[] = [];
    const ctx: BootCtx = createBootCtx({
      memoryConfig: { memoryEnabled: true, memoryDir: join(testHome, "memory") } as never,
    });
    // Facade stub whose close is observable.
    Object.defineProperty(ctx.memoryRuntime, "close", {
      value: async () => { facadeCloseOrder.push("facade-close"); },
    });

    const bridge = new Bridge(ctx);
    const exitPromise = bridge.waitForExit();
    bridge.requestShutdown(0);
    await exitPromise;

    expect(facadeCloseOrder).toEqual(["facade-close"]);
    expect(ctx.memoryRecomposition).toBeNull();
  });
});
