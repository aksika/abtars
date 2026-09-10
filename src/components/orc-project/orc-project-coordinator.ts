import { OrcProjectRunStore } from "./orc-project-run-store.js";
import type {
  OrcInvocationContextV2,
  OrcOwnershipReleasedV1,
  OrcRunFailureCode,
  OrcRunOutcome,
  OrcRunReason,
  OrcRunState,
} from "./orc-project-contracts.js";
import { readBridgeLockField } from "../transport/bridge-lock-transport.js";
import { logInfo } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";

const TAG = "orc-coordinator";

/**
 * #1792: the supervised scheduling path is retired — the workflow runner
 * dispatches all work now. The coordinator retains only the release/
 * supersede ownership boundary (spin.ts release path + reconciler boot
 * recovery) and the ownership-released event.
 */
export interface OrcCoordinatorDeps {
  store?: OrcProjectRunStore;
  /** Override instance ID; defaults to bridge.lock instanceId. */
  ownerInstanceId?: string;
}

export class OrcProjectCoordinator {
  private readonly store: OrcProjectRunStore;
  private readonly ownerInstanceId: string;
  private readonly ownershipListeners = new Set<(event: OrcOwnershipReleasedV1) => void>();

  constructor(deps: OrcCoordinatorDeps) {
    this.store = deps.store ?? new OrcProjectRunStore();
    this.ownerInstanceId = deps.ownerInstanceId ?? readBridgeLockField<string>("instanceId") ?? "unknown";
  }

  /**
   * #1628: subscribe to the in-process ownership-released fact. Returns an
   * unsubscribe function. Dispatch is fail-isolated: a throwing listener is
   * logged and never affects the relinquishment result.
   */
  onOwnershipReleased(listener: (event: OrcOwnershipReleasedV1) => void): () => void {
    this.ownershipListeners.add(listener);
    return () => { this.ownershipListeners.delete(listener); };
  }

  private publishOwnershipReleased(event: OrcOwnershipReleasedV1): void {
    for (const listener of [...this.ownershipListeners]) {
      try {
        listener(event);
      } catch (err) {
        logAndSwallow(TAG, "ownership-released listener", err);
      }
    }
  }

  /**
   * #1628: every committed relinquishment funnels through here so the
   * ownership-released event is published AFTER the CAS applies, never inside
   * the transaction. A lost CAS (or an unknown run) publishes nothing.
   */
  private relinquish(
    runId: string,
    how: "release" | "supersede",
    outcome: OrcRunOutcome,
    context?: OrcInvocationContextV2,
    failureCode?: OrcRunFailureCode,
  ): boolean {
    const row = this.store.getRun(runId); // read BEFORE the CAS
    const applied = how === "release"
      ? this.store.release(context!, outcome, failureCode)
      : this.store.supersede(runId, outcome);
    if (!applied || !row) return applied;
    this.publishOwnershipReleased({
      version: 1,
      projectCardId: row.project_card_id,
      runId,
      intentKind: row.intent_kind,
      outcome,
      started: row.started_at !== null,
    });
    return true;
  }

  /** #1628: public release entry point — publishes the ownership-released event. */
  releaseOwnedRun(context: OrcInvocationContextV2, outcome: OrcRunOutcome, failureCode?: OrcRunFailureCode): boolean {
    return this.relinquish(context.runId, "release", outcome, context, failureCode);
  }

  /**
   * Boot recovery: scan live runs and supersede stale ones.
   * #1628: returns the deduped, ordered project card IDs whose runs
   * were superseded so the caller can wake them AFTER its listeners are
   * registered — the event path alone cannot cover boot-time supersession.
   */
  bootRecovery(): number[] {
    const affected = new Set<number>();
    const runs = this.store.getLiveRuns();
    for (const run of runs) {
      const sup = this.store.db.prepare(`
        SELECT state, generation FROM project_supervision WHERE project_card_id = ?
      `).get(run.project_card_id) as { state: string; generation: number } | undefined;

      if (!sup || sup.state === "accepted" || sup.state === "blocked") {
        logInfo(TAG, `Boot recovery: superseding run ${run.id} — project ${run.project_card_id} is terminal`);
        this.relinquish(run.id, "supersede", "project_terminal");
        affected.add(run.project_card_id);
        continue;
      }

      if (sup.generation !== run.project_generation) {
        logInfo(TAG, `Boot recovery: superseding run ${run.id} — project generation changed (${run.project_generation} → ${sup.generation})`);
        this.relinquish(run.id, "supersede", "generation_changed");
        affected.add(run.project_card_id);
        continue;
      }

      if (run.owner_instance_id !== this.ownerInstanceId) {
        logInfo(TAG, `Boot recovery: superseding run ${run.id} — foreign instance (${run.owner_instance_id})`);
        this.relinquish(run.id, "supersede", "stale");
        affected.add(run.project_card_id);
        continue;
      }

      if (run.state === "dispatching" || run.state === "running") {
        if (!run.session_id || !run.execution_id) {
          logInfo(TAG, `Boot recovery: releasing impossible run ${run.id} — no session/execution`);
          this.relinquish(run.id, "supersede", "stale");
          affected.add(run.project_card_id);
          continue;
        }
        logInfo(TAG, `Boot recovery: keeping live run ${run.id} (${run.state}) for project ${run.project_card_id}`);
      }
    }

    // #1675: boot recovery never promotes. A promoted-but-unstarted run would
    // hold the global slot with no session and no starter; the returned
    // affected project ids are the caller's wake input for the runner-owned
    // redrive path.

    return [...affected].sort((a, b) => a - b);
  }

  getStore(): OrcProjectRunStore {
    return this.store;
  }
}

/**
 * #1671: classify a failed terminal release by reading the run once, after the
 * CAS was lost. Distinct from `releaseOwnedRun`'s boolean: this turns the
 * silent "no-op release" into a bounded, testable classification so the Spin
 * terminal path can log an invariant failure instead of dropping it.
 */
export type OrcReleaseFailure =
  | { kind: "run_unknown" }
  | { kind: "already_terminal"; state: "released" | "superseded" }
  | {
      kind: "rejected_live";
      state: OrcRunState;
      reason: OrcRunReason | "release_rejected";
    };

export function classifyFailedRelease(
  store: OrcProjectRunStore,
  context: OrcInvocationContextV2,
): OrcReleaseFailure {
  const row = store.getRun(context.runId);
  if (!row) return { kind: "run_unknown" as const };
  if (row.state === "released" || row.state === "superseded") {
    return { kind: "already_terminal" as const, state: row.state };
  }
  // Reuse the post-CAS row read; validation still checks current supervision
  // generation, but does not issue a second run-row query.
  const validation = store.validateCurrentContext(context, row);
  return {
    kind: "rejected_live" as const,
    state: row.state,
    reason: validation.ok ? ("release_rejected" as const) : validation.reason,
  };
}
