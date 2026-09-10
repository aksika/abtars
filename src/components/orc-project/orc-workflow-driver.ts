/**
 * orc-workflow-driver.ts — #1792 Task 5: production driver for the runner.
 *
 * Owns ONE WorkflowRunner plus its ports, subscribes the nerve wake events,
 * and exposes the drain + audit entry points used by boot recovery and the
 * heartbeat audit job. Event-driven (nerve wakes + audit redrive); the audit
 * job from the approved heartbeat packet calls auditOnce, never dispatches
 * model work itself.
 *
 * Safe pre-cutover: every handler resolves the workflow run first and returns
 * silently for unmapped cards (legacy flows untouched — no workflow runs
 * exist until admission routing lands).
 */
import { nerve } from "../nerve.js";
import { logWarn } from "../logger.js";
import { WorkflowRunner, boundText, type DrainPorts, type ExecutionPort } from "./orc-workflow-runner.js";
import { WorkflowStore } from "./orc-workflow-store.js";
import {
  WorkflowWorkerPort,
  SpinPlannerBackend,
  SpinReviewerBackend,
  type ModelCall,
} from "./orc-workflow-ports.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

export interface WorkflowDriver {
  readonly runner: WorkflowRunner;
  drainWake(reason: string): number;
  auditOnce(cursor?: number): {
    nextCursor: number; checked: number; lawful: string[]; ownerless: string[];
    recovered: number; inspections: number; projected: number;
  };
  recover(port?: ExecutionPort): { redrivenIngress: number; pendingCommands: number; recoveredCompletions: number };
  stop(): void;
}

const DRAIN_BATCH = 50;
const INSPECTION_CAP_PER_TICK = 100;

export function startWorkflowDriver(deps: {
  db?: TaskDatabase;
  callModel: ModelCall;
  ports?: DrainPorts;
  cursor?: number;
}): WorkflowDriver {
  const store = new WorkflowStore(deps.db);
  const runner = new WorkflowRunner(store);
  const ports: DrainPorts = deps.ports ?? {
    executor: new WorkflowWorkerPort({ runner, db: deps.db }),
    reviewer: new SpinReviewerBackend({ runner, callModel: deps.callModel }),
    planner: new SpinPlannerBackend({ runner, callModel: deps.callModel }),
  };
  let cursor = deps.cursor ?? 0;
  let stopped = false;

  function drainWake(reason: string): number {
    if (stopped) return 0;
    try {
      return runner.drain(DRAIN_BATCH, ports);
    } catch (err) {
      logWarn("workflow-driver", `drain (${reason}) contained: ${boundText(err instanceof Error ? err.message : String(err), 300)}`);
      return 0;
    }
  }

  const onQueued = (): void => { drainWake("card:queued"); };
  const onDone = (): void => { drainWake("card:done"); };
  const onFailed = (): void => { drainWake("card:failed"); };
  nerve.on("card:queued", onQueued);
  nerve.on("card:done", onDone);
  nerve.on("card:failed", onFailed);

  function auditOnce(fromCursor?: number): {
    nextCursor: number; checked: number; lawful: string[]; ownerless: string[];
    recovered: number; inspections: number; projected: number;
  } {
    if (fromCursor !== undefined) cursor = fromCursor;
    const tick = runner.auditTick(cursor);
    cursor = tick.nextCursor;
    const recovered = runner.recoverUnconsumedCompletions(50);
    let projected = 0;
    for (const row of runner.store.findTerminalUnprojected(50)) {
      try {
        if (runner.projectTerminalProjections(row.runId)) projected++;
      } catch (err) {
        logWarn("workflow-driver", `projection recovery contained: ${boundText(err instanceof Error ? err.message : String(err), 200)}`);
      }
    }
    let inspections = 0;
    for (const item of tick.dueInspections) {
      if (inspections >= INSPECTION_CAP_PER_TICK) break;
      try {
        runner.submitClaimInspection(item.runId, item.claimToken, item.inspectGen + 1);
        inspections++;
      } catch (err) {
        logWarn("workflow-driver", `inspection submit contained: ${boundText(err instanceof Error ? err.message : String(err), 200)}`);
      }
    }
    return {
      nextCursor: tick.nextCursor, checked: tick.checked,
      lawful: tick.lawful, ownerless: tick.ownerless, recovered, inspections, projected,
    };
  }

  return {
    runner,
    drainWake,
    auditOnce,
    recover: (port?: ExecutionPort) => runner.startupRecovery(port),
    stop: () => {
      stopped = true;
      nerve.off("card:queued", onQueued);
      nerve.off("card:done", onDone);
      nerve.off("card:failed", onFailed);
    },
  };
}
