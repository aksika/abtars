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
  // #1706: memory may end boot in a composing state (re-composable facade).
  // Facade consumers must await this node as OPTIONAL so a failed initial
  // attempt does not skip them — they hold the facade reference and upgrade
  // in place when late composition lands.
  { name: "memory",       deps: [],                          optional: true,  run: phaseMemory },
  { name: "pipelineDeps", deps: ["transport", "platforms"],  optionalDeps: ["memory"], optional: false, run: phasePipelineDeps },
  { name: "capabilities", deps: ["pipelineDeps"],             optionalDeps: ["memory"], optional: true,  run: phaseCapabilities },
  // memoryIpc removed in #1380 — daemon replaces legacy IPC server
  // #1706: sleep composes against ctx.client; it awaits memory optionally and
  // re-composes when late memory publication delivers the client.
  { name: "sleep",        deps: ["heartbeat"],               optionalDeps: ["memory"], optional: true,  run: phaseSleep },
  { name: "power",        deps: ["heartbeat"],              optionalDeps: ["sleep"], optional: true, run: phasePower },
  // #1706: dashboard awaits memory optionally so its search controller is
  // built over the facade, never over a default disabled runtime.
  { name: "dashboard",    deps: ["heartbeat"],               optionalDeps: ["transport", "memory"], optional: true,  run: phaseDashboard },
  { name: "agentApi",     deps: ["pipelineDeps"],            optional: true,  run: phaseAgentApi },
  { name: "piExecutor",   deps: ["pipelineDeps", "heartbeat"], optionalDeps: ["memory"], optional: true, run: phasePiExecutor },
  // #1554: the Reconciler owns the bridge-generation lifecycle. It requires
  // the pipeline (scheduler + projection ports) and heartbeat, and awaits
  // optional Pi-executor composition so Pi attempts are inspected only after
  // the Pi service exists. BootGraph awaits optional deps regardless of their
  // success status, so phaseReconciler never races the Pi phase.
  { name: "reconciler",   deps: ["pipelineDeps", "heartbeat"], optionalDeps: ["piExecutor"], optional: false, run: phaseReconciler },
  // #1706: session control self-gates per call against the facade.
  { name: "sessionControl", deps: [], optionalDeps: ["piExecutor", "memory"], optional: true, run: phaseSessionControl },
];
