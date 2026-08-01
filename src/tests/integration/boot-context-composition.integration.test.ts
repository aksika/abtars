/**
 * boot-context-composition.integration.test.ts — #1528 deterministic boot
 * order sentinel.
 *
 * Runs the REAL boot graph (bootGraph) with the REAL phasePipelineDeps
 * composition point and REAL phaseMemory (through its documented injection
 * seams), gating memory and transport completion into both orders:
 *
 *   memory ready  -> transport ready -> pipelineDeps
 *   transport ready -> memory ready  -> pipelineDeps
 *
 * After pipelineDeps, the transport-facing readiness/continuity probe must
 * expose the composed durable-context capability in BOTH orders. The sentinel
 * fails if context assignment is performed only as a side effect of one root
 * phase racing the other (e.g. wiring inside phaseTransport when memory
 * happened to complete first).
 */

import { describe, expect, it } from "vitest";
import { bootGraph } from "../../boot/boot-graph.js";
import { createBootCtx, type BootCtx } from "../../boot/context.js";
import { phasePipelineDeps } from "../../boot/phase-pipeline-deps.js";
import { phaseMemory, type MemoryRuntimeFactoryResult, type PhaseMemoryDeps } from "../../boot/phase-memory.js";
import { PiCoreTransport } from "../../components/transport/pi-core-transport.js";
import { ModelHealthRegistry } from "../../components/transport/model-health-registry.js";
import type { DurableContextProviderHolder } from "../../components/transport/pi-core-context.js";
import type { AbtarsMemoryRuntime } from "../../components/memory-runtime.js";
import type { BootNode } from "../../boot/boot-graph.js";

const FAKE_USER_ID = "e2e-sentinel-user";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeRuntime(): AbtarsMemoryRuntime {
  const runtime = {
    state: "ready" as const,
    supports: (capability: string) => capability === "recall" || capability === "durableContext",
    assembleSessionContext: async () => null,
    projectDurableContext: async () => ({ messages: [], estimatedTokens: 0, sourceMessageCount: 0 }),
    recordMessage: async () => ({ id: 1 }),
  } as unknown as AbtarsMemoryRuntime;
  return runtime;
}

/** Transport delegate mirroring phase-transport's capture: it takes the
 *  late-bound holder by reference exactly like PiCoreTransport construction. */
async function makeTransport(ctx: BootCtx): Promise<PiCoreTransport> {
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "",
    candidates: [],
    healthRegistry: new ModelHealthRegistry(undefined),
    sandboxPolicy: { trustedCommands: new Set(), allowBash: false, allowedPaths: [] },
    contextProvider: ctx.durableContextProvider,
  });
}

interface SentinelResult {
  transportHolder: DurableContextProviderHolder;
  composedCurrent: unknown;
}

/**
 * Run the production composition graph with the given completion schedule.
 * Returns the transport's captured holder and the composed capability.
 */
async function runSchedule(order: "memory-first" | "transport-first"): Promise<SentinelResult> {
  const memoryGate = deferred<void>();
  const transportGate = deferred<void>();

  const memoryDeps: PhaseMemoryDeps = {
    resolveEndpoint: () => ({
      mode: "wss",
      source: "explicit",
      profileName: "primary",
      profile: {
        url: "wss://127.0.0.1:1",
        peerId: "sentinel-peer",
        signingKeyFile: "/nonexistent/sentinel.pem",
        serverCertSha256: "a".repeat(64),
      },
    }),
    createRuntime: async (_endpoint): Promise<MemoryRuntimeFactoryResult> => {
      await memoryGate.promise;
      const runtime = fakeRuntime();
      return {
        mode: "wss",
        client: {} as MemoryRuntimeFactoryResult["client"],
        runtime,
        abmindModule: null,
      };
    },
  };

  let transportHolder: DurableContextProviderHolder | null = null;
  const transportNode: BootNode = {
    name: "transport",
    deps: [],
    optional: true,
    run: async (ctx) => {
      await transportGate.promise;
      const transport = await makeTransport(ctx);
      transportHolder = transport.config && (transport as unknown as { _contextProvider: DurableContextProviderHolder })._contextProvider;
      ctx.transport = transport;
      return "ran";
    },
  };

  const platformsNode: BootNode = {
    name: "platforms",
    deps: [],
    optional: true,
    run: async () => "ran",
  };

  const nodes: BootNode[] = [
    { name: "memory", deps: [], optional: true, run: (ctx) => phaseMemory(ctx, memoryDeps) },
    transportNode,
    platformsNode,
    { name: "pipelineDeps", deps: ["transport", "platforms"], optionalDeps: ["memory"], optional: false, run: phasePipelineDeps },
  ];

  const ctx = createBootCtx({
    // phaseConfig normally populates these; the sentinel focuses on the
    // memory/transport/pipelineDeps composition only.
    memoryConfig: { memoryEnabled: true, memoryDir: "/tmp/sentinel-memory" },
    config: {
      transport: {
        agentCliPath: "node",
        workingDir: "/tmp/sentinel-work",
        trustMode: true,
        permissionTimeoutMs: 60_000,
        tmuxSession: "kiro",
        tmuxCaptureDelaySec: 1,
        tmuxMaxWaitSec: 60,
      },
    } as unknown as Parameters<typeof createBootCtx>[0]["config"],
  });
  const bootPromise = bootGraph(nodes, ctx);

  // Execute the schedule: complete one root fully before the other.
  if (order === "memory-first") {
    memoryGate.resolve();
    await new Promise((r) => setTimeout(r, 50));
    transportGate.resolve();
  } else {
    transportGate.resolve();
    await new Promise((r) => setTimeout(r, 50));
    memoryGate.resolve();
  }

  await bootPromise;
  const report = [...ctx.phaseHealth.entries()].map(([k, v]) => `${k}=${v.status}${v.error ? `:${v.error}` : ""}`).join(", ");
  expect(report, `${order}: boot report`).toContain("pipelineDeps=ok");
  expect(ctx.durableContextProvider.current, `${order}: composed provider must be set after pipelineDeps (report: ${report})`).not.toBeNull();
  expect(transportHolder, `${order}: transport must have captured the shared holder`).not.toBeNull();

  return {
    transportHolder: transportHolder!,
    composedCurrent: ctx.durableContextProvider.current,
  };
}

describe("boot context composition (#1528 sentinel)", () => {
  it("composes the durable context capability identically in both completion orders", async () => {
    const memoryFirst = await runSchedule("memory-first");
    const transportFirst = await runSchedule("transport-first");

    // The transport-facing probe is the same kind of ready capability in both
    // orders — never null, never a phase-local placeholder.
    expect(memoryFirst.transportHolder.current).not.toBeNull();
    expect(transportFirst.transportHolder.current).not.toBeNull();
    expect(memoryFirst.composedCurrent).not.toBeNull();
    expect(transportFirst.composedCurrent).not.toBeNull();
    expect(transportFirst.transportHolder.current).toBe(transportFirst.composedCurrent);
    expect(memoryFirst.transportHolder.current).toBe(memoryFirst.composedCurrent);
  });
});
