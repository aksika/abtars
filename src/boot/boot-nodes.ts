/**
 * boot-nodes.ts — boot graph node declarations (#944).
 *
 * Step C: Real parallel dependency graph. Subsystems declare their actual
 * deps and run as soon as satisfied. Memory, transport, platforms all boot
 * in parallel after config.
 */

import type { BootNode } from "./boot-graph.js";
import { phaseMemory } from "./phase-memory.js";
import { phaseTransport } from "./phase-transport.js";
import { phaseMemoryIpc } from "./phase-memory-ipc.js";
import { phasePipelineDeps } from "./phase-pipeline-deps.js";
import { phasePlatformsConnect } from "./phase-platforms-connect.js";
import { phaseCapabilities } from "./phase-capabilities.js";
import { phaseHeartbeat } from "./phase-heartbeat.js";
import { phaseSleep } from "./phase-sleep.js";
import { phaseDashboard } from "./phase-dashboard.js";
import { phaseAgentApi } from "./phase-agent-api.js";

// phaseShutdown is special (takes bridge arg) — wired separately in startBridge()

/**
 * Parallel boot graph. Nodes run as soon as their deps resolve.
 *
 *            config (required)
 *         /    |    \       \
 *  heartbeat  platforms  transport  memory
 *      |         \        /    \       \
 *   dashboard  pipelineDeps  capabilities  memoryIpc
 *                   |                          |
 *                agentApi                    sleep
 */
export const BOOT_NODES: BootNode[] = [
  { name: "heartbeat",    deps: [],                          optional: false, run: phaseHeartbeat },
  { name: "platforms",    deps: [],                          optional: true,  run: phasePlatformsConnect },
  { name: "transport",    deps: [],                          optional: true,  run: phaseTransport },
  { name: "memory",       deps: [],                          optional: true,  run: phaseMemory },
  { name: "pipelineDeps", deps: ["transport", "platforms"],  optionalDeps: ["memory"], optional: false, run: phasePipelineDeps },
  { name: "capabilities", deps: ["transport"],               optionalDeps: ["memory"], optional: true,  run: phaseCapabilities },
  { name: "memoryIpc",    deps: ["memory", "transport"],     optional: true,  run: phaseMemoryIpc },
  { name: "sleep",        deps: ["memory", "heartbeat"],     optional: true,  run: phaseSleep },
  { name: "dashboard",    deps: ["heartbeat"],               optionalDeps: ["transport"], optional: true, run: phaseDashboard },
  { name: "agentApi",     deps: ["pipelineDeps"],            optional: true,  run: phaseAgentApi },
];
