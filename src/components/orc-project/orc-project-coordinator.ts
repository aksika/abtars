import { OrcProjectRunStore } from "./orc-project-run-store.js";
import type {
  OrcInvocationContextV2,
  OrcOriginKind,
  OrcRunClaimResult,
  OrcClaimInput,
  OrcOwnershipReleasedV1,
  OrcTurnSpec,
  OrcTurnControl,
  OrcTurnTerminal,
  OrcRunFailureCode,
} from "./orc-project-contracts.js";
import { readBridgeLockField } from "../transport/bridge-lock-transport.js";
import { logInfo, logWarn } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { intentPolicyFor, readOrcProjectSnapshot } from "./orc-intent-policy.js";
import { kanbanGetCard } from "../tasks/kanban-board.js";
import { scheduledOccurrenceState } from "../tasks/scheduled-occurrence-gate.js";

const TAG = "orc-coordinator";

/** #1680: the start port receives one typed turn specification — immutable
 *  intent, policy-derived prompt bound, and the host-owned one-shot turn
 *  control. Callers cannot pass an independently selected intent or bound. */
export interface OrcStartPort {
  (spec: OrcTurnSpec): Promise<void>;
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
  /**
   * #1707: override the scheduled-occurrence admission read. Defaults to the
   * shared fail-closed gate. Tests may inject a stub to avoid a task catalog.
   */
  scheduledOccurrenceState?: (projectCardId: number) => "active" | "terminal" | "not_scheduled";
}

export class OrcProjectCoordinator {
  private readonly store: OrcProjectRunStore;
  private readonly startPort: OrcStartPort;
  private readonly ownerPeer: string;
  private readonly ownerInstanceId: string;
  private readonly getRootIdentity: (projectCardId: number) => OrcRootIdentity;
  private readonly scheduledOccurrenceState: (projectCardId: number) => "active" | "terminal" | "not_scheduled";
  private readonly ownershipListeners = new Set<(event: OrcOwnershipReleasedV1) => void>();

  constructor(deps: OrcCoordinatorDeps) {
    this.store = deps.store ?? new OrcProjectRunStore();
    this.startPort = deps.startPort;
    this.ownerPeer = deps.ownerPeer;
    this.ownerInstanceId = deps.ownerInstanceId ?? readBridgeLockField<string>("instanceId") ?? "unknown";
    this.getRootIdentity = deps.getRootIdentity ?? defaultRootIdentity;
    this.scheduledOccurrenceState = deps.scheduledOccurrenceState ?? defaultScheduledOccurrenceState;
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
  releaseOwnedRun(context: OrcInvocationContextV2, outcome: import("./orc-project-contracts.js").OrcRunOutcome, failureCode?: OrcRunFailureCode): boolean {
    return this.relinquish(context.runId, "release", outcome, context, failureCode);
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

  scheduleContractAuthoring(projectCardId: number, goal?: string): OrcRunClaimResult {
    const origin = this.deriveOrigin(projectCardId);
    if (!origin) return { kind: "conflict" as const, reason: "origin_invalid" as const };
    return this.scheduleInternal({
      projectCardId,
      intentKind: "contract_authoring",
      originKind: origin.originKind,
      cardSource: this.getRootIdentity(projectCardId).source,
      sourcePeer: origin.originPeer,
    }, goal ?? `Define acceptance contract for project #${projectCardId}; call define_project_contract with project_card_id=${projectCardId}`);
  }

  /**
   * #1680: Post-contract Orc planning/synthesis for supervised projects.
   * Persists the truthful `project_execution` intent (distinct from
   * `contract_authoring`) and its derived `execute:<project>:<generation>`
   * key. Valid only after a contract exists; the Reconciler's owner
   * precedence decides whether this claim is reached at all. The first
   * claimant's goal wins the start port.
   */
  scheduleProjectExecution(projectCardId: number, goal: string): OrcRunClaimResult {
    const origin = this.deriveOrigin(projectCardId);
    if (!origin) return { kind: "conflict" as const, reason: "origin_invalid" as const };
    return this.scheduleInternal({
      projectCardId,
      intentKind: "project_execution",
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

  private scheduleInternal(input: Omit<OrcClaimInput, "goal">, goal: string): OrcRunClaimResult {
    // #1707: the durable occurrence gate is an absolute ownership boundary and
    // runs BEFORE any run-row insertion or provider start. A scheduled root
    // whose task occurrence is terminal/missing is never claimed here; the
    // reconciler's last-resort settlement owns that project instead.
    if (this.scheduledOccurrenceState(input.projectCardId) === "terminal") {
      logWarn(TAG, `Project ${input.projectCardId}: refusing ${input.intentKind} claim — owning scheduled occurrence is terminal`);
      return { kind: "conflict" as const, reason: "occurrence_terminal" as const };
    }

    const result = this.store.claimIntent({ ...input, goal }, this.ownerPeer, this.ownerInstanceId);

    // #1675: promote exactly the run this claim owns (or the existing run an
    // idempotent re-claim matches) and start it with the RUN ROW's persisted
    // goal. An `idempotent` result proves identity (same intent key, same
    // owner instance) — never that the caller's goal equals the run's first-
    // claimant goal, so the caller's goal is never used here. Queued runs of
    // other projects are reached by their own project's wake, which rebuilds
    // that project's goal and re-enters this same scoped promotion.
    if (result.kind === "claimed" || result.kind === "idempotent") {
      const runId = result.context.runId;
      if (this.store.promoteRun(runId)) {
        const promoted = this.store.getRun(runId);
        if (promoted && promoted.state === "dispatching") {
          // #1680: the turn spec is composed only from the persisted run row
          // and its central intent policy — never from the caller's goal or an
          // independently selected intent/bound.
          this.startPort(buildTurnSpec(this.store, promoted)).catch((err) => {
            logWarn(TAG, `Orc start port failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
            // #1628/#1680: through the funnel so the ownership-released event
            // wakes the project and the failed run persists the stable
            // `start_port_rejected` code — the release is the recovery signal,
            // not the scheduler's next opportunistic scan. With pump() gone
            // there is no second promotion attempt here.
            this.releaseOwnedRun(buildContextForRun(promoted), "failed", "start_port_rejected");
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

    // #1675: boot recovery never promotes. A promoted-but-unstarted run would
    // hold the global slot with no session and no starter; the returned
    // affected project ids are the caller's wake input, which re-enters each
    // project's scheduleX and promotes through the scoped path with the row's
    // own goal.

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

function defaultRootIdentity(projectCardId: number): OrcRootIdentity {
  try {
    const card = kanbanGetCard(projectCardId);
    return { source: card?.source ?? "agent", sourcePeer: card?.source_peer ?? null };
  } catch {
    return { source: "agent", sourcePeer: null };
  }
}

/** #1707: shared fail-closed occurrence gate — the coordinator-side default. */
function defaultScheduledOccurrenceState(projectCardId: number): "active" | "terminal" | "not_scheduled" {
  try {
    const card = kanbanGetCard(projectCardId);
    if (!card) return "not_scheduled";
    return scheduledOccurrenceState(card);
  } catch {
    // Fail closed: an unreadable board never admits a claim.
    return "terminal";
  }
}

function buildContextForRun(run: import("./orc-project-contracts.js").OrcProjectRunRow): OrcInvocationContextV2 {
  return {
    version: 2,
    runId: run.id,
    intentKey: run.intent_key,
    intentKind: run.intent_kind,
    intentRef: run.intent_ref ?? undefined,
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

/**
 * #1680: compose the one typed turn specification from the persisted promoted
 * run row and its central intent policy. `maxPromptRounds` and the allowed
 * tool surface come from the policy; the turn control re-verifies the durable
 * intent postcondition before it can win.
 */
function buildTurnSpec(
  store: OrcProjectRunStore,
  run: import("./orc-project-contracts.js").OrcProjectRunRow,
): OrcTurnSpec {
  const policy = intentPolicyFor(run.intent_kind);
  const context = buildContextForRun(run);
  return {
    context,
    goal: run.goal,
    maxPromptRounds: policy.maxPromptRounds,
    turnControl: createOrcTurnControl(run.id, (terminal) => {
      // #1680: `intent_satisfied` is accepted only after re-reading the durable
      // postcondition under the exact bound run — a tool result string is never
      // proof. Read failures fail closed to unsatisfied.
      if (terminal.kind !== "intent_satisfied") return true;
      try {
        const current = store.getRun(run.id);
        if (!current || !isExactLiveRun(current, run)) return false;
        const completion = policy.completion(readOrcProjectSnapshot(store.db, run.project_card_id));
        return completion.satisfied;
      } catch {
        return false;
      }
    }),
  };
}

/** #1680: durable identity fence for a turn-control completion callback. */
function isExactLiveRun(
  current: import("./orc-project-contracts.js").OrcProjectRunRow,
  expected: import("./orc-project-contracts.js").OrcProjectRunRow,
): boolean {
  if (current.state !== "dispatching" && current.state !== "running") return false;
  return current.id === expected.id
    && current.intent_key === expected.intent_key
    && current.intent_kind === expected.intent_kind
    && current.intent_ref === expected.intent_ref
    && current.project_card_id === expected.project_card_id
    && current.project_generation === expected.project_generation
    && current.ownership_generation === expected.ownership_generation
    && current.owner_peer === expected.owner_peer
    && current.owner_instance_id === expected.owner_instance_id
    && current.origin_kind === expected.origin_kind
    && current.origin_peer === expected.origin_peer;
}

/**
 * #1680: host-owned one-shot turn control. The first `complete()` call wins;
 * an `intent_satisfied` terminal is accepted only when the supplied durable
 * verification succeeds. Completion is a host fact distinct from cancellation:
 * late tool/model events after completion are rejected by the run CAS and the
 * Spin execution generation.
 */
export function createOrcTurnControl(
  runId: string,
  verify: (terminal: OrcTurnTerminal) => boolean,
): OrcTurnControl {
  let completed: OrcTurnTerminal | null = null;
  return {
    runId,
    get completed(): OrcTurnTerminal | null { return completed; },
    complete(terminal: OrcTurnTerminal): boolean {
      if (completed !== null) return false;
      if (!verify(terminal)) return false;
      completed = terminal;
      return true;
    },
  };
}
