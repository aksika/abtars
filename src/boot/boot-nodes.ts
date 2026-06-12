/**
 * boot-nodes.ts — boot graph node declarations (#944).
 *
 * Step B: deps mirror the current sequential order (each phase depends on
 * the previous one). This makes bootGraph() behavior-identical to the old loop.
 * Step C will relax deps to enable true parallelism.
 */

import type { BootNode } from "./boot-graph.js";
import { phaseConfig } from "./phase-config.js";
import { phaseMemory } from "./phase-memory.js";
import { phaseTransport } from "./phase-transport.js";
import { phaseMemoryIpc } from "./phase-memory-ipc.js";
import { phasePipelineDeps } from "./phase-pipeline-deps.js";
import { phasePlatforms } from "./phase-platforms.js";
import { phaseCapabilities } from "./phase-capabilities.js";
import { phaseHeartbeat } from "./phase-heartbeat.js";
import { phaseSleep } from "./phase-sleep.js";
import { phaseDashboard } from "./phase-dashboard.js";
import { phaseAgentApi } from "./phase-agent-api.js";

// phaseShutdown is special (takes bridge arg) — wired separately in startBridge()

/**
 * Current graph: sequential chain (Step B — behavior-identical to old loop).
 * Each node depends on the previous, enforcing the same execution order.
 * Step C will relax these deps for true parallel boot.
 */
export const BOOT_NODES: BootNode[] = [
  { name: "config",       deps: [],              optional: false, run: phaseConfig },
  { name: "memory",       deps: ["config"],      optional: true,  run: phaseMemory },
  { name: "transport",    deps: ["memory"],      optional: true,  run: phaseTransport },
  { name: "memoryIpc",    deps: ["transport"],   optional: true,  run: phaseMemoryIpc },
  { name: "pipelineDeps", deps: ["memoryIpc"],   optional: true,  run: phasePipelineDeps },
  { name: "platforms",    deps: ["pipelineDeps"], optional: true, run: phasePlatforms },
  { name: "capabilities", deps: ["platforms"],   optional: true,  run: phaseCapabilities },
  { name: "heartbeat",    deps: ["capabilities"], optional: true, run: phaseHeartbeat },
  { name: "sleep",        deps: ["heartbeat"],   optional: true,  run: phaseSleep },
  { name: "dashboard",    deps: ["sleep"],       optional: true,  run: phaseDashboard },
  { name: "agentApi",     deps: ["dashboard"],   optional: true,  run: phaseAgentApi },
];
