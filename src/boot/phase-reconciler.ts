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
import { kanbanGetCard } from "../components/tasks/kanban-board.js";
import { loadPeerConfig } from "../components/peer-config.js";
import { OrcProjectCoordinator } from "../components/orc-project/orc-project-coordinator.js";
import { SpinWorkerAdapter } from "../components/spin-worker-adapter.js";
import { ReconcileQuarantineStore } from "../components/reconcile-quarantine-store.js";
import { WorkerSupervisionStore } from "../components/worker-supervision-store.js";
import { PiExecutorAdapter } from "../components/pi-executor-adapter.js";
import { ProjectReviewStore } from "../components/project-acceptance/project-review-store.js";
import type { ToolExecutionScope } from "../components/tasks/task-package.js";
import type { ReconcilerDeps } from "../components/reconciler.js";

const TAG = "reconciler";

const MAX_UNRESOLVED_WARNINGS = 20;

/** #1656: reconstruct the bound execution scope for a scheduled Orc turn. */
function executionScopeFor(context: { projectCardId: number }): ToolExecutionScope | undefined {
  const project = kanbanGetCard(context.projectCardId);
  const isScheduledRoot = project?.source === "task" && project.source_id != null && project.source_id.length > 0;
  if (isScheduledRoot) {
    const scope = new ProjectReviewStore().getWorkspaceScope(context.projectCardId);
    if (!scope) {
      throw new Error(`scheduled project #${context.projectCardId} has no bound workspace — refusing to start Orc turn`);
    }
    return scope;
  }
  // Non-scheduled roots keep their explicitly supplied/session scope.
  return new ProjectReviewStore().getWorkspaceScope(context.projectCardId) ?? undefined;
}

export async function phaseReconciler(ctx: BootCtx): Promise<PhaseResult> {
  const scheduler = ctx.lifecycleWakeScheduler;
  const inputs = ctx.reconcilerInputs;
  if (!scheduler || !inputs) {
    throw new Error("phase-reconciler: lifecycle wake scheduler or Reconciler inputs missing on BootCtx");
  }

  const { startReconciler, scanActiveProjects, retryPendingReviewRequests } = await import("../components/reconciler.js");
  const { spin } = await import("../components/spin.js");

  // Load the local peer identity for coordinator ownership.
  const peerName = loadPeerConfig().self.name;

  // The Orc coordinator is constructed exactly once per bridge generation —
  // never in agent-api, request paths, or the scheduled-project runner.
  const coordinator = new OrcProjectCoordinator({
    ownerPeer: peerName,
    startPort: async (context, goal) => {
      await spin.spin({
        type: "O",
        goal,
        sessionId: context.sessionId,
        cardId: context.projectCardId,
        settlementOwner: "spin",
        source: "agent",
        orcContext: context,
        executionScope: executionScopeFor(context),
      });
    },
  });

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

  const handle = await startReconciler(deps);
  ctx.reconcilerHandle = handle;
  ctx.reconcilerRecovery = handle.recovery;

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

  // #1554 (approved heartbeat move): the Reconciler-owned safety/retry tasks
  // register only after a successful generation start. project-acceptance-
  // outbox stays independently registered in Tier-3.
  if (ctx.heartbeat) {
    ctx.heartbeat.registerTask({
      name: "reconciler-resync",
      execute: async () => {
        scanActiveProjects();
        const { ProjectReviewStore } = await import("../components/project-acceptance/project-review-store.js");
        const expired = new ProjectReviewStore().abandonExpiredRequests();
        return { state: expired > 0 ? "ran" : "idle" as const };
      },
    });
    ctx.heartbeat.registerTask({
      name: "review-request-retry",
      execute: async () => {
        const count = retryPendingReviewRequests();
        return { state: count > 0 ? "ran" : "idle" as const };
      },
    });
  }

  return "ran";
}
