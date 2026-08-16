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
// Memory IPC removed in #1380 — daemon replaces MemoryIpcServer + SqliteBackend fallback
import { phasePipelineDeps } from "./phase-pipeline-deps.js";
import { phasePlatformsConnect } from "./phase-platforms-connect.js";
import { phaseCapabilities } from "./phase-capabilities.js";
import { phaseHeartbeat } from "./phase-heartbeat.js";
import { phaseSleep } from "./phase-sleep.js";
import { phasePower } from "./phase-power.js";
import { phaseDashboard } from "./phase-dashboard.js";
import { phaseAgentApi } from "./phase-agent-api.js";
import { phasePiExecutor } from "./phase-pi-executor.js";
import { phaseSessionControl } from "./phase-session-control.js";
import { phaseReconciler } from "./phase-reconciler.js";

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
  { name: "heartbeat",    deps: [],                            optional: false, run: phaseHeartbeat },
  { name: "platforms",    deps: [],                          optional: true,  run: phasePlatformsConnect },
  { name: "transport",    deps: [],                          optional: true,  run: phaseTransport },
  { name: "memory",       deps: [],                          optional: true,  run: phaseMemory },
  { name: "pipelineDeps", deps: ["transport", "platforms"],  optionalDeps: ["memory"], optional: false, run: phasePipelineDeps },
  { name: "capabilities", deps: ["pipelineDeps"],             optionalDeps: ["memory"], optional: true,  run: phaseCapabilities },
  // memoryIpc removed in #1380 — daemon replaces legacy IPC server
  { name: "sleep",        deps: ["memory", "heartbeat"],     optional: true,  run: phaseSleep },
  { name: "power",        deps: ["heartbeat"],              optionalDeps: ["sleep"], optional: true, run: phasePower },
  { name: "dashboard",    deps: ["heartbeat"],               optionalDeps: ["transport"], optional: true, run: phaseDashboard },
  { name: "agentApi",     deps: ["pipelineDeps"],            optional: true,  run: phaseAgentApi },
  { name: "piExecutor",   deps: ["pipelineDeps", "heartbeat"], optionalDeps: ["memory"], optional: true, run: phasePiExecutor },
  // #1554: the Reconciler owns the bridge-generation lifecycle. It requires
  // the pipeline (scheduler + projection ports) and heartbeat, and awaits
  // optional Pi-executor composition so Pi attempts are inspected only after
  // the Pi service exists. BootGraph awaits optional deps regardless of their
  // success status, so phaseReconciler never races the Pi phase.
  { name: "reconciler",   deps: ["pipelineDeps", "heartbeat"], optionalDeps: ["piExecutor"], optional: false, run: phaseReconciler },
  { name: "sessionControl", deps: ["memory"], optionalDeps: ["piExecutor"], optional: true, run: phaseSessionControl },
];
