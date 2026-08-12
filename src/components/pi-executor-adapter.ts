import { logWarn } from "./logger.js";
import { PiExecutor } from "./pi-executor/pi-executor.js";
import { ExecutorProgressEmitter } from "./executor-progress-emitter.js";
import type { SwarmExecutorAdapter, ExecutionClaim, ExecutorCapacity, StartObservation, CancelObservation, ExecutionObservation, CancelReason } from "./swarm-executor-types.js";
import type { WorkerSupervisionStore } from "./worker-supervision-store.js";

const TAG = "pi-adapter";

/**
 * #1638 — a supervised Pi attempt binds its runtime resource through the
 * WorkerSupervisionStore binding columns; the attempt never doubles as a Pi
 * run ID. The adapter creates one subordinate Pi run per W card (via
 * PiRunStore.createSupervisedRun), binds generation 1 before launch, and
 * resolves the binding for start/inspect/cancel/progress.
 */
export class PiExecutorAdapter implements SwarmExecutorAdapter {
  readonly kind = "pi" as const;
  readonly schedulingPolicy = { recovery: "inspectable" as const };
  private executor: PiExecutor;
  private supervisionStore: WorkerSupervisionStore;
  private progressEmitter?: ExecutorProgressEmitter;
  private readonly leaseUnsubscribers = new Map<string, () => void>();

  constructor(executor: PiExecutor, supervisionStore: WorkerSupervisionStore, progressEmitter?: ExecutorProgressEmitter) {
    this.executor = executor;
    this.supervisionStore = supervisionStore;
    this.progressEmitter = progressEmitter;
  }

  private _emitter(): ExecutorProgressEmitter {
    if (!this.progressEmitter) {
      this.progressEmitter = new ExecutorProgressEmitter();
    }
    return this.progressEmitter;
  }

  capacitySnapshot(): ExecutorCapacity {
    return {
      available: Math.max(0, this.executor.maxConcurrent - this.executor.activeCount),
      max: this.executor.maxConcurrent,
    };
  }

  async capacity(): Promise<ExecutorCapacity> {
    return this.capacitySnapshot();
  }

  /** Ensure a binding exists for (attempt, generation) -> Pi run. Idempotent:
   * the same card always resolves to the same run row. Initial execution
   * binds generation 1; a retry advances the existing run row via
   * queueSupervisedGeneration and binds resumed|fresh continuity. */
  private ensureBinding(claim: ExecutionClaim): { runId: string; resourceGeneration: number } | undefined {
    const existing = this.supervisionStore.getExecutorResourceBinding(claim.attemptId);
    if (existing) return { runId: existing.resourceId, resourceGeneration: existing.resourceGeneration };
    // #1638: the contract's workspace_alias is the only workspace locator.
    const contractRow = this.supervisionStore.getContractByCardId(claim.cardId);
    let workspaceAlias = "default";
    if (contractRow) {
      try {
        const parsed = JSON.parse(contractRow.contract_json) as { workspace_alias?: string };
        if (parsed.workspace_alias) workspaceAlias = parsed.workspace_alias;
      } catch { /* unreadable contract — default alias */ }
    }
    const run = this.executor.piStore.getByCardId(claim.cardId);
    const created = run
      ? { runId: run.id, generation: run.executionGeneration, created: false }
      : this.executor.piStore.createSupervisedRun({
          cardId: claim.cardId,
          workspaceAlias,
          goal: `worker attempt ${claim.attemptId}`,
          ownerPrincipalId: `peer:${claim.executorId}`,
          sessionId: `${Date.now()}_C_pi_${claim.attemptId}`,
        });
    let resourceGeneration = created.generation;
    let continuity: "initial" | "resumed" | "fresh" = "initial";
    if (run && (run.status === "interrupted" || run.status === "failed")) {
      // #1638: retry — advance the same run row; the session decides resumed
      // vs fresh. Never a second run row, never a W-card touch.
      const session = this.executor.piStore.resolveSessionContinuity(run.id);
      const advanced = this.executor.piStore.queueSupervisedGeneration({
        runId: run.id,
        expectedGeneration: run.executionGeneration,
        newSessionId: session.sessionId,
        sessionFile: session.sessionFile,
        continuity: session.continuity,
      });
      if (!advanced.committed || advanced.newGeneration === undefined) {
        logWarn(TAG, `supervised generation advance failed for ${claim.attemptId}: ${advanced.reason}`);
        return undefined;
      }
      resourceGeneration = advanced.newGeneration;
      continuity = session.continuity;
    }
    const outcome = this.supervisionStore.bindExecutorResource({
      attemptId: claim.attemptId,
      expectedAttemptGeneration: claim.generation,
      executorKind: "pi",
      resourceId: created.runId,
      resourceGeneration,
      continuity,
    });
    if (outcome === "stale" || outcome === "conflict") {
      logWarn(TAG, `bind rejected for ${claim.attemptId}: ${outcome}`);
      return undefined;
    }
    return { runId: created.runId, resourceGeneration };
  }

  /** #1638: resolve the configured canonical path for a supervised run. */
  private resolveCanonicalPath(runId: string): { canonicalPath: string } | undefined {
    const run = this.executor.piStore.get(runId);
    if (!run) return undefined;
    const { resolveAndValidateWorkspace } = require("./pi-executor/config.js") as typeof import("./pi-executor/config.js");
    const ws = resolveAndValidateWorkspace(run.workspaceAlias, this.executor.config);
    if (ws.error || !ws.canonicalPath) return undefined;
    return { canonicalPath: ws.canonicalPath };
  }

  async start(claim: ExecutionClaim): Promise<StartObservation> {
    try {
      const binding = this.ensureBinding(claim);
      if (!binding) return { kind: "start_failed", reason: "resource binding failed", retryable: false };
      // Bind first, then subscribe. Wiring before ensureBinding falls back to
      // attemptId as a resource ID and silently drops all real Pi progress.
      try {
        this.leaseUnsubscribers.get(claim.attemptId)?.();
        this.leaseUnsubscribers.set(claim.attemptId, this.wireLeaseProgress(claim.attemptId, claim.generation, claim.executorId));
        this._emitter().emitAlive(claim.attemptId, claim.generation, claim.executorId, "pi");
      } catch { /* best-effort */ }
      // #1638: acquire the shared canonical-workspace claim BEFORE launch.
      // Capacity/workspace contention maps to the generic deferred outcome —
      // the attempt returns to pending and no process is started.
      const ws = this.resolveCanonicalPath(binding.runId);
      if (!ws) return { kind: "start_failed", reason: "workspace alias unresolvable", retryable: false };
      const wsClaim = this.executor.piStore.claimSupervisedGeneration({
        runId: binding.runId,
        expectedGeneration: binding.resourceGeneration,
        canonicalPath: ws.canonicalPath,
      });
      if (wsClaim.kind === "busy") {
        return { kind: "deferred", reason: "resource_busy", provesNoStart: true };
      }
      if (wsClaim.kind === "stale") {
        return { kind: "start_failed", reason: `workspace claim stale: ${wsClaim.reason}`, retryable: false };
      }
      if (this.executor.activeCount >= this.executor.maxConcurrent) {
        this.executor.piStore.releaseWorkspaceClaim({
          canonicalPath: ws.canonicalPath, runId: binding.runId, generation: binding.resourceGeneration, restoreQueued: true,
        });
        return { kind: "deferred", reason: "capacity", provesNoStart: true };
      }
      const run = this.executor.piStore.get(binding.runId);
      const sessionId = run?.currentSessionId ?? `${Date.now()}_C_pi_${binding.runId}`;
      const result = await this.executor.startWithClaim(binding.runId, binding.resourceGeneration, sessionId);
      switch (result) {
        case "started":
          return { kind: "started", attemptId: claim.attemptId, generation: claim.generation, executorId: claim.executorId };
        default:
          this.executor.piStore.releaseWorkspaceClaim({
            canonicalPath: ws.canonicalPath, runId: binding.runId, generation: binding.resourceGeneration,
          });
          this.executor.notifyCapacityReleased();
          return { kind: "start_failed", reason: String(result), retryable: false };
      }
    } catch (err) {
      logWarn(TAG, `start failed for ${claim.attemptId}: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: "start_failed", reason: "exception", retryable: true };
    }
  }

  private resolveRunId(claim: ExecutionClaim): string | undefined {
    const binding = this.supervisionStore.getExecutorResourceBinding(claim.attemptId);
    if (binding) return binding.resourceId;
    // Boot-recovery fallback: an attempt without a binding has no Pi run —
    // do not fabricate one from the attempt ID.
    return undefined;
  }

  async cancel(claim: ExecutionClaim, _reason: CancelReason): Promise<CancelObservation> {
    const runId = this.resolveRunId(claim);
    if (!runId) return { kind: "cancelled", attemptId: claim.attemptId };
    try {
      await this.executor.cancel(runId);
      this.leaseUnsubscribers.get(claim.attemptId)?.();
      this.leaseUnsubscribers.delete(claim.attemptId);
      return { kind: "cancelled", attemptId: claim.attemptId };
    } catch (err) {
      logWarn(TAG, `cancel failed for ${claim.attemptId}: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: "cancel_failed", reason: String(err) };
    }
  }

  async inspect(claim: ExecutionClaim): Promise<ExecutionObservation> {
    const runId = this.resolveRunId(claim);
    if (!runId) return { kind: "unknown", message: "no Pi run binding" };
    const run = this.executor.piStore.get(runId);
    if (!run) return { kind: "unknown", message: "run not found" };
    switch (run.status) {
      case "starting":
      case "running":
      case "awaiting_input":
        return { kind: "running", lifecycle: "running" };
      case "completed":
        return { kind: "terminal", lifecycle: "completed" };
      case "failed":
        return { kind: "terminal", lifecycle: "failed" };
      case "cancelled":
        return { kind: "terminal", lifecycle: "cancelled" };
      case "interrupted":
        // Boot recovery converts an active Pi run to interrupted before the
        // Worker coordinator settles it. Treat the durable interruption as a
        // terminal failure observation if reconciliation gets there first.
        return { kind: "terminal", lifecycle: "failed" };
      default:
        return { kind: "unknown", message: `status=${run.status}` };
    }
  }

  /** Wire local Pi progress into the lease progress store. */
  wireLeaseProgress(attemptId: string, claimGeneration: number, executorId: string): () => void {
    const binding = this.supervisionStore.getExecutorResourceBinding(attemptId);
    const runId = binding?.resourceId ?? attemptId;
    const unsubTransition = this.executor.onTransition((rid, _fromStatus, toStatus) => {
      if (rid !== runId) return;
      const emitter = this._emitter();
      const run = this.executor.piStore.get(rid);
      switch (toStatus) {
        case "running":
          if (_fromStatus === "awaiting_input" && run?.lastUiReplyRequestId) {
            emitter.emitInputResolved(attemptId, claimGeneration, executorId, run.lastUiReplyRequestId, "pi");
          }
          emitter.emitAlive(attemptId, claimGeneration, executorId, "pi");
          break;
        case "awaiting_input":
          if (run?.pendingRequestId) {
            emitter.emitInputStart(attemptId, claimGeneration, executorId, run.pendingRequestId, undefined, "pi");
          }
          break;
        case "starting":
          break;
        default:
          if (["completed", "failed", "cancelled", "interrupted"].includes(toStatus)) {
            const unsubscribe = this.leaseUnsubscribers.get(attemptId);
            if (unsubscribe) {
              unsubscribe();
              this.leaseUnsubscribers.delete(attemptId);
            }
          }
          break;
      }
    });

    const unsubProgress = this.executor.onProgress((rid, payload, progressType) => {
      if (rid !== runId) return;
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const name = typeof parsed["name"] === "string" ? parsed["name"] : "tool";
      if (progressType === "tool_execution_start") {
        this._emitter().emitToolStart(attemptId, claimGeneration, executorId, `pi-tool:${rid}:${name}`, name, undefined, "pi");
      } else if (progressType === "tool_execution_end") {
        this._emitter().emitToolEnd(attemptId, claimGeneration, executorId, `pi-tool:${rid}:${name}`, `pi-tool-end:${rid}:${name}:${Date.now()}`, "pi");
      } else if (progressType === "agent_start") {
        this._emitter().emitAlive(attemptId, claimGeneration, executorId, "pi");
      }
    });

    return () => { unsubTransition(); unsubProgress(); };
  }
}
