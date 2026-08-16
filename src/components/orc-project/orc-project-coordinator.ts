import { OrcProjectRunStore } from "./orc-project-run-store.js";
import type {
  OrcInvocationContextV1,
  OrcOriginKind,
  OrcRunClaimResult,
  OrcClaimInput,
  OrcOwnershipReleasedV1,
} from "./orc-project-contracts.js";
import { readBridgeLockField } from "../transport/bridge-lock-transport.js";
import { logInfo, logWarn } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";

const TAG = "orc-coordinator";

export interface OrcStartPort {
  (context: OrcInvocationContextV1, goal: string): Promise<void>;
}

/** #1618: durable root identity — card source plus the authenticated source peer. */
export interface OrcRootIdentity {
  source: string;
  sourcePeer: string | null;
}

export interface OrcCoordinatorDeps {
  store?: OrcProjectRunStore;
  /** Injected exact Spin O-start port — not legacy dispatch(). */
  startPort: OrcStartPort;
  /** Stable logical peer name (from loadPeerConfig().self.name). */
  ownerPeer: string;
  /** Override instance ID; defaults to bridge.lock instanceId. */
  ownerInstanceId?: string;
  /** Override root identity read; defaults to reading kanban source + source_peer. */
  getRootIdentity?: (projectCardId: number) => OrcRootIdentity;
}

export class OrcProjectCoordinator {
  private readonly store: OrcProjectRunStore;
  private readonly startPort: OrcStartPort;
  private readonly ownerPeer: string;
  private readonly ownerInstanceId: string;
  private readonly getRootIdentity: (projectCardId: number) => OrcRootIdentity;
  private readonly ownershipListeners = new Set<(event: OrcOwnershipReleasedV1) => void>();

  constructor(deps: OrcCoordinatorDeps) {
    this.store = deps.store ?? new OrcProjectRunStore();
    this.startPort = deps.startPort;
    this.ownerPeer = deps.ownerPeer;
    this.ownerInstanceId = deps.ownerInstanceId ?? readBridgeLockField<string>("instanceId") ?? "unknown";
    this.getRootIdentity = deps.getRootIdentity ?? defaultRootIdentity;
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
    outcome: import("./orc-project-contracts.js").OrcRunOutcome,
    context?: OrcInvocationContextV1,
  ): boolean {
    const row = this.store.getRun(runId); // read BEFORE the CAS
    const applied = how === "release"
      ? this.store.release(context!, outcome)
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
  releaseOwnedRun(context: OrcInvocationContextV1, outcome: import("./orc-project-contracts.js").OrcRunOutcome): boolean {
    return this.relinquish(context.runId, "release", outcome, context);
  }

  /**
   * #1618: centralized claim-origin derivation. A peer-sourced root requires
   * the authenticated source peer; missing/blank identity fails closed and must
   * never fall back to local. Task/CLI/agent roots are local.
   */
  private deriveOrigin(projectCardId: number): { originKind: OrcOriginKind; originPeer: string | null } | null {
    const root = this.getRootIdentity(projectCardId);
    if (root.source === "peer") {
      const peer = root.sourcePeer;
      if (!peer || peer.trim().length === 0) return null;
      return { originKind: "peer", originPeer: peer };
    }
    return { originKind: "local", originPeer: null };
  }

  scheduleContractAuthoring(projectCardId: number): OrcRunClaimResult {
    const origin = this.deriveOrigin(projectCardId);
    if (!origin) return { kind: "conflict" as const, reason: "origin_invalid" as const };
    return this.scheduleInternal({
      projectCardId,
      intentKind: "contract_authoring",
      originKind: origin.originKind,
      cardSource: this.getRootIdentity(projectCardId).source,
      sourcePeer: origin.originPeer,
    }, `Define acceptance contract for project #${projectCardId}; call define_project_contract with project_card_id=${projectCardId}`);
  }

  /**
   * #1516: Goal-bearing contract-authoring start for supervised projects.
   * Keeps the `contract_authoring` intent kind (and its derived intent key) so
   * the Reconciler's generic re-schedule is idempotent against this claim.
   * The first claimant's goal wins the start port.
   */
  scheduleScheduledProject(projectCardId: number, goal: string): OrcRunClaimResult {
    const origin = this.deriveOrigin(projectCardId);
    if (!origin) return { kind: "conflict" as const, reason: "origin_invalid" as const };
    return this.scheduleInternal({
      projectCardId,
      intentKind: "contract_authoring",
      originKind: origin.originKind,
      cardSource: this.getRootIdentity(projectCardId).source,
      sourcePeer: origin.originPeer,
    }, goal);
  }

  scheduleReview(projectCardId: number, _projectGeneration: number, reviewCaseId: string): OrcRunClaimResult {
    const origin = this.deriveOrigin(projectCardId);
    if (!origin) return { kind: "conflict" as const, reason: "origin_invalid" as const };
    return this.scheduleInternal({
      projectCardId,
      intentKind: "project_review",
      intentRef: reviewCaseId,
      originKind: origin.originKind,
      cardSource: this.getRootIdentity(projectCardId).source,
      sourcePeer: origin.originPeer,
      expectedProjectGeneration: _projectGeneration,
    }, `Review project #${projectCardId}: first read the immutable case with get_project_review_case (project_card_id=${projectCardId}, project_generation=${_projectGeneration}, review_case_id=${reviewCaseId}), then submit exactly one review_project decision using its legal_values and compatible evidence ids.`);
  }

  scheduleRepairReview(projectCardId: number, _projectGeneration: number): OrcRunClaimResult {
    const origin = this.deriveOrigin(projectCardId);
    if (!origin) return { kind: "conflict" as const, reason: "origin_invalid" as const };
    return this.scheduleInternal({
      projectCardId,
      intentKind: "repair_review",
      intentRef: undefined,
      originKind: origin.originKind,
      cardSource: this.getRootIdentity(projectCardId).source,
      sourcePeer: origin.originPeer,
      expectedProjectGeneration: _projectGeneration,
    }, `Repair review for project #${projectCardId}`);
  }

  scheduleInputResume(projectCardId: number, _projectGeneration: number, round: number): OrcRunClaimResult {
    const origin = this.deriveOrigin(projectCardId);
    if (!origin) return { kind: "conflict" as const, reason: "origin_invalid" as const };
    return this.scheduleInternal({
      projectCardId,
      intentKind: "input_resume",
      intentRef: String(round),
      originKind: origin.originKind,
      cardSource: this.getRootIdentity(projectCardId).source,
      sourcePeer: origin.originPeer,
      expectedProjectGeneration: _projectGeneration,
    }, `Resume review for project #${projectCardId} after input (round ${round})`);
  }

  scheduleOperatorTurn(projectCardId: number, requestId: string): OrcRunClaimResult {
    const origin = this.deriveOrigin(projectCardId);
    if (!origin) return { kind: "conflict" as const, reason: "origin_invalid" as const };
    return this.scheduleInternal({
      projectCardId,
      intentKind: "operator_turn",
      intentRef: requestId,
      originKind: origin.originKind,
      cardSource: this.getRootIdentity(projectCardId).source,
      sourcePeer: origin.originPeer,
    }, `Operator turn for project #${projectCardId}`);
  }

  private scheduleInternal(input: OrcClaimInput, goal: string): OrcRunClaimResult {
    const result = this.store.claimIntent(input, this.ownerPeer, this.ownerInstanceId);

    if (result.kind === "claimed") {
      const promoted = this.store.pump();
      if (promoted) {
        const promotedRun = this.store.getRun(promoted);
        if (promotedRun && promotedRun.state === "dispatching") {
          const context = buildContextForRun(promotedRun);
          this.startPort(context, goal).catch((err) => {
            logWarn(TAG, `Orc start port failed for run ${promoted}: ${err instanceof Error ? err.message : String(err)}`);
            // #1628: through the funnel so the ownership-released event wakes
            // the project — the release is the recovery signal, not the
            // scheduler's next opportunistic scan.
            this.releaseOwnedRun(buildContextForRun(promotedRun), "failed");
            this.store.pump();
          });
        }
      }
    }

    return result;
  }

  /**
   * Boot recovery: scan live runs, supersede stale ones, reschedule actionable
   * intents. #1628: returns the deduped, ordered project card IDs whose runs
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

    const promoted = this.store.pump();
    if (promoted) {
      logInfo(TAG, `Boot recovery: promoted run ${promoted} after recovery`);
    }

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
      state: import("./orc-project-contracts.js").OrcRunState;
      reason: import("./orc-project-contracts.js").OrcRunReason | "release_rejected";
    };

export function classifyFailedRelease(
  store: OrcProjectRunStore,
  context: OrcInvocationContextV1,
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

function defaultRootIdentity(projectCardId: number): OrcRootIdentity {
  try {
    const { kanbanGetCard } = require("../tasks/kanban-board.js");
    const card = kanbanGetCard(projectCardId);
    return { source: card?.source ?? "agent", sourcePeer: card?.source_peer ?? null };
  } catch {
    return { source: "agent", sourcePeer: null };
  }
}

function buildContextForRun(run: import("./orc-project-contracts.js").OrcProjectRunRow): OrcInvocationContextV1 {
  return {
    version: 1,
    runId: run.id,
    intentKey: run.intent_key,
    projectCardId: run.project_card_id,
    projectGeneration: run.project_generation,
    ownershipGeneration: run.ownership_generation,
    ownerPeer: run.owner_peer,
    ownerInstanceId: run.owner_instance_id,
    origin: {
      kind: run.origin_kind,
      peer: run.origin_peer ?? undefined,
    },
    sessionId: run.session_id ?? undefined,
    executionId: run.execution_id ?? undefined,
  };
}
