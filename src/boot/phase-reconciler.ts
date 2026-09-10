/**
 * phase-reconciler — #1554: compose and start the single Reconciler
 * bridge-generation runtime.
 *
 * Runs after pipelineDeps (scheduler + scheduled-run projection ports on
 * BootCtx) and heartbeat, awaiting optional Pi-executor composition so Pi
 * attempts are never inspected before the Pi service exists.
 *
 * Owns: the Orc coordinator, the Spin worker adapter, the Pi adapter factory,
 * the generation-owned quarantine-store accessor, and the Reconciler handle.
 */

import { logWarn, logInfo } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { OrcProjectCoordinator } from "../components/orc-project/orc-project-coordinator.js";
import { SpinWorkerAdapter } from "../components/spin-worker-adapter.js";
import { ReconcileQuarantineStore } from "../components/reconcile-quarantine-store.js";
import { WorkerSupervisionStore } from "../components/worker-supervision-store.js";
import { PiExecutorAdapter } from "../components/pi-executor-adapter.js";
import type { ReconcilerDeps, ReconcilerHandle } from "../components/reconciler.js";
import type { WorkflowDriver } from "../components/orc-project/orc-workflow-driver.js";
import type { HeartbeatSystem } from "../components/heartbeat-system.js";

const TAG = "reconciler";

const MAX_UNRESOLVED_WARNINGS = 20;

/** #1792: the bounded audit replaces reconciler-resync at its existing cadence.
 * review-request-retry is removed: its obligations live in the runner/outbox
 * and the existing wake scheduler (separately approved heartbeat change).
 * No timing or watchdog threshold changes. */
export function registerReconcilerHeartbeatTasks(
  heartbeat: HeartbeatSystem,
  audit: () => { acted: boolean },
): void {
  heartbeat.registerTask({
    name: "reconciler-resync",
    execute: async () => {
      const summary = audit();
      return { state: summary.acted ? "ran" : "idle" as const };
    },
  });
}

export async function phaseReconciler(ctx: BootCtx): Promise<PhaseResult> {
  const scheduler = ctx.lifecycleWakeScheduler;
  const inputs = ctx.reconcilerInputs;
  const heartbeat = ctx.heartbeat;
  if (!scheduler || !inputs || !heartbeat) {
    throw new Error("phase-reconciler: lifecycle wake scheduler, heartbeat, or Reconciler inputs missing on BootCtx");
  }

  let handle: ReconcilerHandle | null = null;
  let workflowDriver: WorkflowDriver | null = null;
  let getActiveOrcCoordinator: (() => OrcProjectCoordinator | null) | undefined;
  try {
    const reconciler = await import("../components/reconciler.js");
    const { startReconciler } = reconciler;
    getActiveOrcCoordinator = reconciler.getActiveOrcCoordinator;

    // #1792: the coordinator retains only the release/supersede ownership
    // boundary — the workflow runner dispatches all work now, so no start
    // port is injected. The Orc coordinator is constructed exactly once per
    // bridge generation.
    const coordinator = new OrcProjectCoordinator({});

    // Generation-owned memoized quarantine-store accessor. Construction stays
    // inside the #1664 safe wrappers so DDL failure degrades fail-open.
    let quarantineStore: ReconcileQuarantineStore | null = null;
    const getQuarantineStore = (): ReconcileQuarantineStore => quarantineStore ??= new ReconcileQuarantineStore();

    const deps: ReconcilerDeps = {
      generationId: `boot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      coordinator,
      wakeScheduler: scheduler,
      workerAdapter: new SpinWorkerAdapter(),
      piService: ctx.piExecutorService ?? null,
      createPiAdapter: (service) => new PiExecutorAdapter(service.executor, new WorkerSupervisionStore()),
      getQuarantineStore,
      projectRunProgress: inputs.projectRunProgress,
      failureCascade: inputs.failureCascade,
    };

    handle = await startReconciler(deps);
    ctx.reconcilerHandle = handle;
    ctx.reconcilerRecovery = handle.recovery;

    // #1792: start the workflow driver alongside the reconciler. The driver
    // owns supervised runs (nerve wakes + bounded audit); the reconciler keeps
    // executor dispatch, leases, quarantine, and unsupervised duties. With no
    // workflow runs admitted the driver is a silent no-op.
    const { startWorkflowDriver } = await import("../components/orc-project/orc-workflow-driver.js");
    const { spin } = await import("../components/spin.js");
    workflowDriver = startWorkflowDriver({
      callModel: (prompt, timeoutMs) => spin.dispatchBackground({ prompt, timeoutMs }),
    });
    try {
      workflowDriver.recover();
    } catch (err) {
      logWarn(TAG, `Workflow driver recovery contained: ${err instanceof Error ? err.message : String(err)}`);
    }

    // #1688: one bounded SHA boot-recovery pass after the Reconciler
    // generation exists (review-state recovery needs requestReconcileForProject).
    if (ctx.shaCoordinator) {
      ctx.shaCoordinator.runBootRecovery();
    }

    // #1554: scheduled-run admission starts only after the generation exists.
    // Recover active runs from a prior crash FIRST, then start the scheduler —
    // new due occurrences are never admitted ahead of recovery, and no
    // admission can race the generation's coordinator.
    if (ctx.scheduledRunCoordinator && ctx.cronQueue) {
      const { readEntries } = await import("../components/tasks/task-store.js");
      await ctx.scheduledRunCoordinator.recover(readEntries(), (entry, run) => {
        const enqueueResult = ctx.cronQueue!.enqueue(entry, false, run);
        if (enqueueResult) {
          logWarn(TAG, `Could not reattach scheduled project ${entry.id}: ${enqueueResult}`);
          return false;
        }
        return true;
      });
    }
    await scheduler.start();
    logInfo(TAG, `Reconciler generation ${handle.generationId} started — ${handle.recovery.attempts.length} attempt(s) accounted, ${handle.recovery.recoveredProjectIds.length} recovered project(s)`);

    // Bounded, structured warnings for unresolved recovery results.
    const unresolved = handle.recovery.attempts.filter((a): a is Extract<typeof a, { kind: "unresolved" }> => a.kind === "unresolved");
    for (const entry of unresolved.slice(0, MAX_UNRESOLVED_WARNINGS)) {
      logWarn(TAG, `Recovery unresolved: attempt ${entry.attemptId} (${entry.executorKind}/${entry.executorId}) — ${entry.reason}${entry.detail ? `: ${entry.detail}` : ""}`);
    }
    if (unresolved.length > MAX_UNRESOLVED_WARNINGS) {
      logWarn(TAG, `Recovery unresolved: ${unresolved.length - MAX_UNRESOLVED_WARNINGS} further attempt(s) omitted (bounded)`);
    }

    // #1792 (approved heartbeat change): the bounded audit replaces
    // reconciler-resync at its existing cadence; review-request-retry is gone
    // (obligations live in the runner/outbox + wake scheduler). The audit
    // never dispatches model work: it redrives persisted commands, submits
    // inspection ingress for suspect claims, and reports ownerless runs for
    // the runner to fence. No timing or watchdog changes.
    // Narrowed once: the audit closure below captures this const, so the
    // nullable outer (needed for catch-path rollback) cannot leak in.
    const driver = workflowDriver;
    registerReconcilerHeartbeatTasks(heartbeat, () => {
      const audit = driver.auditOnce();
      return {
        acted: audit.recovered + audit.inspections + audit.projected + audit.ownerless.length > 0,
      };
    });

    return "ran";
  } catch (err) {
    // The Reconciler is the owner of this generation. If any later boot step
    // fails after start, roll it back before propagating the phase failure so
    // no listeners, lease source, static hook, due scheduler, or workflow
    // driver survives a failed boot generation.
    if (workflowDriver) {
      try { workflowDriver.stop(); } catch (stopErr) {
        logWarn(TAG, `Workflow driver rollback failed: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`);
      }
    }
    if (handle) {
      try { await handle.stop(); } catch (stopErr) {
        logWarn(TAG, `Reconciler rollback failed: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`);
      }
      if (ctx.reconcilerHandle === handle) ctx.reconcilerHandle = null;
      if (ctx.reconcilerRecovery === handle.recovery) ctx.reconcilerRecovery = null;
    }
    // A duplicate phase invocation must not stop the scheduler owned by an
    // already-running generation. Other failures own this phase's scheduler
    // and must stop it before the failed phase is reported.
    if (!getActiveOrcCoordinator || getActiveOrcCoordinator() === null) scheduler.stop();
    throw err;
  }
}
