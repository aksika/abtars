import { OrcProjectRunStore } from "./orc-project-run-store.js";
import type {
  OrcInvocationContextV1,
  OrcRunClaimResult,
  OrcClaimInput,
} from "./orc-project-contracts.js";
import { readBridgeLockField } from "../transport/bridge-lock-transport.js";
import { logInfo, logWarn } from "../logger.js";

const TAG = "orc-coordinator";

export interface OrcStartPort {
  (context: OrcInvocationContextV1, goal: string): Promise<void>;
}

export interface OrcCoordinatorDeps {
  store?: OrcProjectRunStore;
  /** Injected exact Spin O-start port — not legacy dispatch(). */
  startPort: OrcStartPort;
  /** Stable logical peer name (from loadPeerConfig().self.name). */
  ownerPeer: string;
  /** Override instance ID; defaults to bridge.lock instanceId. */
  ownerInstanceId?: string;
  /** Override card source check; defaults to reading kanban. */
  getCardSource?: (projectCardId: number) => string;
}

export class OrcProjectCoordinator {
  private readonly store: OrcProjectRunStore;
  private readonly startPort: OrcStartPort;
  private readonly ownerPeer: string;
  private readonly ownerInstanceId: string;
  private readonly getCardSource: (projectCardId: number) => string;

  constructor(deps: OrcCoordinatorDeps) {
    this.store = deps.store ?? new OrcProjectRunStore();
    this.startPort = deps.startPort;
    this.ownerPeer = deps.ownerPeer;
    this.ownerInstanceId = deps.ownerInstanceId ?? readBridgeLockField<string>("instanceId") ?? "unknown";
    this.getCardSource = deps.getCardSource ?? defaultCardSource;
  }

  scheduleContractAuthoring(projectCardId: number): OrcRunClaimResult {
    return this.scheduleInternal({
      projectCardId,
      intentKind: "contract_authoring",
      originKind: "local",
      cardSource: this.getCardSource(projectCardId),
      sourcePeer: null,
    }, `Define acceptance contract for project #${projectCardId}; call define_project_contract with project_card_id=${projectCardId}`);
  }

  scheduleReview(projectCardId: number, _projectGeneration: number, reviewCaseId: string): OrcRunClaimResult {
    return this.scheduleInternal({
      projectCardId,
      intentKind: "project_review",
      intentRef: reviewCaseId,
      originKind: "local",
      cardSource: this.getCardSource(projectCardId),
      sourcePeer: null,
      expectedProjectGeneration: _projectGeneration,
    }, `Review project #${projectCardId}: project_card_id=${projectCardId}, project_generation=${_projectGeneration}, review_case_id=${reviewCaseId}`);
  }

  scheduleRepairReview(projectCardId: number, _projectGeneration: number): OrcRunClaimResult {
    return this.scheduleInternal({
      projectCardId,
      intentKind: "repair_review",
      intentRef: undefined,
      originKind: "local",
      cardSource: this.getCardSource(projectCardId),
      sourcePeer: null,
      expectedProjectGeneration: _projectGeneration,
    }, `Repair review for project #${projectCardId}`);
  }

  scheduleInputResume(projectCardId: number, _projectGeneration: number, round: number): OrcRunClaimResult {
    return this.scheduleInternal({
      projectCardId,
      intentKind: "input_resume",
      intentRef: String(round),
      originKind: "local",
      cardSource: this.getCardSource(projectCardId),
      sourcePeer: null,
      expectedProjectGeneration: _projectGeneration,
    }, `Resume review for project #${projectCardId} after input (round ${round})`);
  }

  scheduleOperatorTurn(projectCardId: number, requestId: string): OrcRunClaimResult {
    return this.scheduleInternal({
      projectCardId,
      intentKind: "operator_turn",
      intentRef: requestId,
      originKind: "local",
      cardSource: this.getCardSource(projectCardId),
      sourcePeer: null,
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
            this.store.release(buildContextForRun(promotedRun), "failed");
            this.store.pump();
          });
        }
      }
    }

    return result;
  }

  /** Boot recovery: scan live runs, supersede stale ones, reschedule actionable intents. */
  bootRecovery(): void {
    const runs = this.store.getLiveRuns();
    for (const run of runs) {
      const sup = this.store.db.prepare(`
        SELECT state, generation FROM project_supervision WHERE project_card_id = ?
      `).get(run.project_card_id) as { state: string; generation: number } | undefined;

      if (!sup || sup.state === "accepted" || sup.state === "blocked") {
        logInfo(TAG, `Boot recovery: superseding run ${run.id} — project ${run.project_card_id} is terminal`);
        this.store.supersede(run.id, "project_terminal");
        continue;
      }

      if (sup.generation !== run.project_generation) {
        logInfo(TAG, `Boot recovery: superseding run ${run.id} — project generation changed (${run.project_generation} → ${sup.generation})`);
        this.store.supersede(run.id, "generation_changed");
        continue;
      }

      if (run.owner_instance_id !== this.ownerInstanceId) {
        logInfo(TAG, `Boot recovery: superseding run ${run.id} — foreign instance (${run.owner_instance_id})`);
        this.store.supersede(run.id, "stale");
        continue;
      }

      if (run.state === "dispatching" || run.state === "running") {
        if (!run.session_id || !run.execution_id) {
          logInfo(TAG, `Boot recovery: releasing impossible run ${run.id} — no session/execution`);
          this.store.supersede(run.id, "stale");
          continue;
        }
        logInfo(TAG, `Boot recovery: keeping live run ${run.id} (${run.state}) for project ${run.project_card_id}`);
      }
    }

    const promoted = this.store.pump();
    if (promoted) {
      logInfo(TAG, `Boot recovery: promoted run ${promoted} after recovery`);
    }
  }

  getStore(): OrcProjectRunStore {
    return this.store;
  }
}

function defaultCardSource(projectCardId: number): string {
  try {
    const { kanbanGetCard } = require("../tasks/kanban-board.js");
    return kanbanGetCard(projectCardId)?.source ?? "agent";
  } catch {
    return "agent";
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
