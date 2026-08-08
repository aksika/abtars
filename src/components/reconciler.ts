import { nerve } from "./nerve.js";
import { spin } from "./spin.js";
import {
  kanbanFail,
  kanbanGetCard, kanbanGetChildren, kanbanRunningProjectIds,
  kanbanQueuedDispatchOrder, kanbanPromoteDueRetry, kanbanTransition, sqliteNow, KANBAN_TERMINAL_STATUSES,
  isUnblocked, cascadeFail, type KanbanCard,
} from "./tasks/kanban-board.js";
import { logInfo, logWarn } from "./logger.js";
import { logSwarmTrace } from "./swarm-trace.js";
import { WorkerSupervisionService } from "./worker-supervision-service.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { SpinWorkerAdapter } from "./spin-worker-adapter.js";
import type { SwarmExecutorAdapter, ExecutionClaim } from "./swarm-executor-types.js";
import { resolveSchedulingPolicy, deriveDeadline } from "./swarm-dispatch-policy.js";
import { LeaseReconciliationService } from "./executor-lease-reconciler.js";
import type { LifecycleWakeScheduler } from "./lifecycle-wake-scheduler.js";
import { ExecutorLeaseStore } from "./executor-lease-store.js";
import { ProjectReviewStore, type ProjectState, type ProjectSupervisionRow } from "./project-acceptance/project-review-store.js";
import { ReviewCaseAssembler } from "./project-acceptance/project-review-case.js";
import { readProjectCriterionCoverage, coverageSignature } from "./project-acceptance/project-criterion-coverage.js";
import { OrcProjectRunStore } from "./orc-project/orc-project-run-store.js";
import { readEntries } from "./tasks/task-store.js";
import { readState } from "./tasks/task-state-store.js";
import { settleRunOnce } from "./tasks/task-run-settler.js";
import { makeTaskFailure } from "./tasks/task-failure.js";
import type { TaskFailureDiagnosticV1 } from "./tasks/task-failure.js";
import type { PiRunService } from "./pi-executor/pi-run-service.js";
import type { AttemptLifecycle, AttemptRow } from "./worker-supervision-store.js";
import type { WorkerAcceptanceContractV1 } from "./worker-contract.js";

const TAG = "reconciler";

let _shutdownRequested = false;

let _piService: PiRunService | null = null;
let _workerAdapter: SwarmExecutorAdapter | null = null;

export function setPiService(service: PiRunService | null): void {
  _piService = service;
}

export function setWorkerAdapter(adapter: SwarmExecutorAdapter | null): void {
  _workerAdapter = adapter;
}

function workerAdapter(): SwarmExecutorAdapter {
  return _workerAdapter ??= new SpinWorkerAdapter();
}

function dispatchExecutor(executorKind: string, executorId: string): { kind: "agent" | "pi"; id: string; adapter: SwarmExecutorAdapter } | undefined {
  if (executorKind === "local_worker" || executorKind === "agent") {
    // Older attempts were created as local_worker/spin. They are still Spin
    // attempts, but all new claims use the durable executor identity below.
    return { kind: "agent", id: "spin-local", adapter: workerAdapter() };
  }
  if (executorKind === "pi" && _piService) {
    const { PiExecutorAdapter } = require("./pi-executor-adapter.js") as typeof import("./pi-executor-adapter.js");
    return { kind: "pi", id: executorId, adapter: new PiExecutorAdapter(_piService.executor) };
  }
  return undefined;
}

export function requestShutdown(): void {
  _shutdownRequested = true;
}

import type { OrcProjectCoordinator } from "./orc-project/orc-project-coordinator.js";

let _orcCoordinator: OrcProjectCoordinator | null = null;

// #1604 R2: coverage-round bounds. MAX_COVERAGE_ROUNDS is the absolute ceiling
// on coverage turns; COVERAGE_ROUND_GRACE_MS bounds only the non-scheduled
// legacy dispatch path, whose claim is not durably observable.
const MAX_COVERAGE_ROUNDS = 3;
const COVERAGE_ROUND_GRACE_MS = 60_000;

export function setOrcCoordinator(c: OrcProjectCoordinator | null): void {
  _orcCoordinator = c;
}

export function getOrcCoordinator(): OrcProjectCoordinator | null {
  return _orcCoordinator;
}

/**
 * #1516: Get the shared Orc coordinator, initializing it (and its boot
 * recovery) on first use. The scheduled-project runner calls this so its
 * goal-bearing claim races ahead of the Reconciler's generic authoring goal.
 */
export function getOrCreateOrcCoordinator(): OrcProjectCoordinator | null {
  if (_orcCoordinator) return _orcCoordinator;
  try {
    const { loadPeerConfig } = require("./peer-config.js") as typeof import("./peer-config.js");
    const peerName = loadPeerConfig().self.name;
    const { OrcProjectCoordinator } = require("./orc-project/orc-project-coordinator.js") as typeof import("./orc-project/orc-project-coordinator.js");
    _orcCoordinator = new OrcProjectCoordinator({
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
        });
      },
    });
    logInfo(TAG, "Orc coordinator initialized");
    _orcCoordinator.bootRecovery();
  } catch (err) {
    logWarn(TAG, `Failed to initialize Orc coordinator: ${err instanceof Error ? err.message : String(err)}`);
  }
  return _orcCoordinator;
}

/**
 * #1516: Public project-abort boundary. Terminalizes all non-terminal Worker
 * children and the root idempotently. A terminal root (accepted/delivered/
 * failed) is never touched — late cancellation cannot clobber settled state.
 */
export async function abortProjectById(projectId: number, reason: string): Promise<void> {
  const card = kanbanGetCard(projectId);
  if (!card) return;
  if (card.status === "done" || card.status === "delivered" || card.status === "failed") {
    logInfo(TAG, `Project ${projectId}: already terminal (${card.status}) — abort skipped`);
    return;
  }
  const children = kanbanGetChildren(projectId);
  await abortProject(projectId, children, reason);
}

function scheduleOrcReview(projectId: number, generation: number, caseId: string, requestId: string): void {
  if (_orcCoordinator) {
    const result = _orcCoordinator.scheduleReview(projectId, generation, caseId);
    if (result.kind === "claimed" || result.kind === "idempotent") {
      try { (new ProjectReviewStore()).bumpReviewRequestAttempt(requestId); } catch {}
    }
  } else {
    legacyOrcReviewDispatch(projectId, generation, caseId, requestId);
  }
}

function legacyOrcDispatch(goal: string, cardId: number): void {
  try {
    spin.dispatch({ type: "O", goal, source: "agent", cardId, settlementOwner: "spin" });
  } catch (err) {
    logWarn(TAG, `Failed to dispatch Orc — ${err instanceof Error ? err.message : String(err)}`);
  }
}

function legacyOrcReviewDispatch(projectId: number, generation: number, caseId: string, requestId: string): void {
  try {
    spin.dispatch({ type: "O", goal: `Review project #${projectId}: project_card_id=${projectId}, project_generation=${generation}, review_case_id=${caseId}`, source: "agent", cardId: projectId, settlementOwner: "spin" });
    try { (new ProjectReviewStore()).bumpReviewRequestAttempt(requestId); } catch {}
  } catch (err) {
    logWarn(TAG, `Failed to dispatch Orc review — ${err instanceof Error ? err.message : String(err)}`);
  }
}

function scheduleContractAuthoringOrSettle(projectId: number): boolean {
  if (!_orcCoordinator) {
    logWarn(TAG, `Project ${projectId}: Orc coordinator unavailable while authoring contract — settling as last resort`);
    settleProjectLastResort(projectId);
    return false;
  }

  const result = _orcCoordinator.scheduleContractAuthoring(projectId);
  if (result.kind === "not_actionable") {
    logWarn(TAG, `Project ${projectId}: contract-authoring claim not actionable (${result.reason}) — settling as last resort`);
    settleProjectLastResort(projectId);
    return false;
  }
  return true;
}

// ── Keyed scheduler (per-card reconciliation) ────────────────────────────────

interface CardReconcilerState {
  running: boolean;
  dirty: boolean;
}

const _states = new Map<number, CardReconcilerState>();

function getState(cardId: number): CardReconcilerState {
  let s = _states.get(cardId);
  if (!s) { s = { running: false, dirty: false }; _states.set(cardId, s); }
  return s;
}

function wakeCard(cardId: number): void {
  const s = getState(cardId);
  if (s.running) { s.dirty = true; return; }
  s.running = true;
  s.dirty = false;
  queueMicrotask(() => reconcileCard(cardId));
}

async function reconcileCard(cardId: number): Promise<void> {
  const s = getState(cardId);
  try {
    do {
      s.dirty = false;
      if (_shutdownRequested) return;
      await deriveAction(cardId);
    } while (s.dirty);
  } finally {
    s.running = false;
  }
}

// ── Derive action ─────────────────────────────────────────────────────────────

/**
 * #1546 R1: scheduled-root identity — a root card with all durable identity
 * facts: type O, no parent, task source, non-empty source_id (the scheduled
 * runId), and a non-terminal `project_supervision` row. Unsupervised
 * parentless cards and Worker children are never classified here.
 */
function isScheduledRootIdentity(card: KanbanCard): boolean {
  if (card.type !== "O" || card.parent_id !== null) return false;
  if (card.source !== "task" || !card.source_id || card.source_id.length === 0) return false;
  return true;
}

function isScheduledProjectRoot(card: KanbanCard): boolean {
  if (!isScheduledRootIdentity(card)) return false;
  try {
    return new ProjectReviewStore().hasActiveProjectSupervision(card.id);
  } catch {
    return false;
  }
}

/** #1546 R2: the queued due check uses the durable retry marker, never card age. */
function isRetryDue(card: KanbanCard, now?: number): boolean {
  if (!card.next_retry_at) return false;
  const t = Date.parse(card.next_retry_at);
  const nowVal = now ?? Date.now();
  return Number.isFinite(t) && t <= nowVal;
}

async function deriveAction(cardId: number): Promise<void> {
  if (cardId <= 0) return;
  const card = kanbanGetCard(cardId);
  if (!card) return;

  if (card.type === "O") {
    // #1546: running roots always reconcile; queued roots reconcile only when
    // they are a scheduled project whose retry is due. Queued+future and
    // unrelated roots remain no-ops or on their existing path.
    if (card.status === "running") {
      await reconcileProject(cardId);
      return;
    }
    if (card.status === "queued" && isScheduledProjectRoot(card) && isRetryDue(card)) {
      await reconcileProject(cardId);
      return;
    }
  }

  await reconcileChildCard(card);
}

const RESUMPTIVE_ATTEMPT_LIFECYCLES = new Set<AttemptLifecycle>(["pending", "claimed", "starting", "running", "cancel_requested"]);

type OwnerInspection =
  | "terminal"
  | "worker_resume"
  | "review"
  | "input"
  | "repair"
  | "executing_terminal_children"
  | "orc_claim"
  | "none";

type BranchResult = "transitioned" | "owned" | "none";

/**
 * #1546 R3: the exact durable owner predicate. Evaluates durable rows only —
 * in-memory handles, unsettled promises, or merely expected processes never
 * count as custody. The Reconciler's own case creation owns an executing
 * project whose direct children are all terminal (the Orc's `review_project`
 * requires an open case that only the Reconciler can assemble).
 */
function inspectProjectOwnership(projectId: number, supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore): OwnerInspection {
  if (supervision.state === "accepted" || supervision.state === "blocked") return "terminal";

  const children = kanbanGetChildren(projectId);
  const workerStore = new WorkerSupervisionStore();

  // R2: repair_planned with a valid durable decision and repair items is the
  // Reconciler worker-creation owner. Checked before worker_resume so a
  // repair round already carrying running worker rows still transitions to
  // repairing instead of being stuck re-dispatching the same round.
  if (supervision.state === "repair_planned") {
    const decision = reviewStore.getLatestDecisionForProject(projectId);
    if (decision) {
      try {
        const parsed = JSON.parse(decision.decision_json) as { repair?: { items?: unknown[] } };
        if ((parsed.repair?.items?.length ?? 0) > 0) return "repair";
      } catch { /* fall through — no durable repair items */ }
    }
  }

  // R3.1: resumable direct-child work — a non-terminal latest attempt on an
  // exact direct child. `pending` is resumable without a lease; missing or
  // expired leases stay owned by the existing lease reconciliation path.
  for (const child of children) {
    let hasContract = false;
    try { hasContract = workerStore.contractExists(child.id); } catch { hasContract = false; }
    if (!hasContract) continue;
    let attempt: AttemptRow | undefined;
    try { attempt = workerStore.getLatestAttempt(child.id); } catch { attempt = undefined; }
    if (attempt && RESUMPTIVE_ATTEMPT_LIFECYCLES.has(attempt.lifecycle)) return "worker_resume";
  }

  // R3.2: existing project-state owners.
  if (reviewStore.getLatestOpenCase(projectId)) return "review";
  if (supervision.state === "needs_input") {
    // answered rows are consumed by the existing resume transition, so both
    // pending and answered requests make the input owner authoritative
    const pending = reviewStore.getPendingInputRequests().filter(r => r.project_card_id === projectId);
    const answered = reviewStore.getAnsweredInputRequests(projectId);
    if (pending.length > 0 || answered.length > 0) return "input";
  }
  if (supervision.state === "repairing") {
    const anyLive = children.some(c => c.status === "queued" || c.status === "running");
    const allTerminal = children.length > 0 && children.every(c => KANBAN_TERMINAL_STATUSES.includes(c.status));
    if (anyLive || allTerminal) return "repair";
  }

  // R2: the Reconciler's review case creation owns an executing project whose
  // direct children are all terminal. Zero children is NOT this owner — it
  // must reach the no-owner decision.
  if (supervision.state === "executing" && children.length > 0 && children.every(c => KANBAN_TERMINAL_STATUSES.includes(c.status))) {
    return "executing_terminal_children";
  }

  // R3.2: a live Orc row matching the current supervision generation is an
  // existing durable owner — never a fresh claim.
  try {
    const liveRun = new OrcProjectRunStore().getLiveRunForProject(projectId);
    if (liveRun && liveRun.project_generation === supervision.generation) return "orc_claim";
  } catch { /* fail-closed: no live-claim observation */ }

  return "none";
}

/**
 * #1546: the running root's no-owner path. Only a non-terminal project with no
 * resumable owner and no claimable continuation reaches last-resort settlement.
 */
function claimScheduledContinuation(projectId: number, _supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore, project: KanbanCard): "owned" | "settled" {
  const coordinator = getOrCreateOrcCoordinator();
  if (!coordinator) {
    logWarn(TAG, `Project ${projectId}: Orc coordinator unavailable — settling as last resort`);
    settleProjectLastResort(projectId);
    return "settled";
  }
  // The goal is the root card's durable scheduled goal when available,
  // otherwise a bounded continuation instruction naming the card and run.
  const goal = project.goal && project.goal.trim().length > 0
    ? project.goal
    : `[CONTINUATION] Scheduled project #${projectId}, run ${project.source_id ?? "unknown"}: inspect the existing project contract and durable project rows and resume the supervised lifecycle from its current durable state (spawn pending Workers, complete the review, or settle). Do not re-author the contract.`;

  const result = coordinator.scheduleScheduledProject(projectId, goal);
  switch (result.kind) {
    case "claimed":
    case "idempotent":
      logInfo(TAG, `Project ${projectId}: scheduled Orc continuation ${result.kind} — coordinator owns it`);
      return "owned";
    case "busy": {
      logInfo(TAG, `Project ${projectId}: scheduled continuation busy — live run ${result.activeRunId} owns it; no second run created`);
      return "owned";
    }
    case "conflict": {
      // #1546 R3: conflict is never a direct settle signal. Re-read supervision
      // and re-derive ownership once; only a second pass that still finds no
      // owner and no claimable continuation may settle.
      const reRead = reviewStore.getSupervision(projectId);
      if (reRead) {
        const rederived = inspectProjectOwnership(projectId, reRead, reviewStore);
        if (rederived !== "none") {
          logInfo(TAG, `Project ${projectId}: continuation conflict — re-derive found owner ${rederived}`);
          return "owned";
        }
        const retry = coordinator.scheduleScheduledProject(projectId, goal);
        if (retry.kind === "claimed" || retry.kind === "idempotent" || retry.kind === "busy") return "owned";
      }
      settleProjectLastResort(projectId);
      return "settled";
    }
    case "not_actionable":
      logWarn(TAG, `Project ${projectId}: scheduled continuation not actionable (${result.reason}) — settling as last resort`);
      settleProjectLastResort(projectId);
      return "settled";
  }
}

/**
 * #1546 R3.4: last-resort settlement for a correlated scheduled root with no
 * durable owner and no claimable continuation. Freezes the project through the
 * existing idempotent abortProject path, then settles the matching active
 * scheduled run exactly once with `interruption/restart_interrupted`. Never
 * waits for the absolute run deadline. `appendRunOnce` in the settler is the
 * single dedupe authority: a concurrent waiter settle returns duplicate/late.
 */
export function settleProjectLastResort(projectId: number): void {
  const card = kanbanGetCard(projectId);
  if (!card) return;
  const matched = findActiveScheduledRun(card);
  const children = kanbanGetChildren(projectId);
  const reason = "no scheduled Orc continuation owner after restart";
  // The freeze must not prevent the exactly-once settle: even if a child
  // cancellation rejects, the occurrence still settles through the settler.
  void abortProject(projectId, children, reason, { skipRootFail: true })
    .catch((err) => logWarn(TAG, `last-resort abort for project ${projectId} failed — ${err instanceof Error ? err.message : String(err)}`))
    .then(() => {
    if (!matched) {
      // There is no run row to settle, but the root still needs terminal
      // evidence. Without this mutation the supervision row is blocked while
      // the Kanban root remains queued/running forever.
      kanbanFail(projectId, reason);
      return;
    }
    try {
      settleRunOnce({
        entry: matched.entry,
        run: matched.run,
        outcome: "failed",
        diagnostic: makeTaskFailure("interruption", "restart_interrupted", "executing", "scheduled project continuation unavailable after restart", "none"),
        detail: "reconcileProject: no durable owner and no claimable scheduled Orc continuation",
        cardId: projectId,
        onFailure: _failureCascade,
      });
      logInfo(TAG, `Project ${projectId}: settled run ${matched.run.runId} as restart_interrupted (last resort)`);
    } catch (err) {
      logWarn(TAG, `Project ${projectId}: last-resort settlement failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

function findActiveScheduledRun(card: KanbanCard): { entry: import("./tasks/task-types.js").ScheduledTask; run: import("./tasks/task-state-store.js").ActiveTaskRun } | undefined {
  try {
    for (const entry of readEntries()) {
      const state = readState(entry.id);
      const run = state?.activeRun;
      if (run && run.runId === card.source_id && run.cardId === card.id) return { entry, run };
    }
  } catch (err) {
    logWarn(TAG, `findActiveScheduledRun failed for card ${card.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

/**
 * #1546 R3.4: state-branch ownership handlers. `handleInputState` and
 * `handleRepairState` return "transitioned" when they advanced the project
 * (the driver re-reads and re-derives), "owned" when an existing owner holds
 * the state, and "none" when a prerequisite is missing (fall through to the
 * scheduled Orc continuation).
 */
function handleInputState(projectId: number, _supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore): BranchResult {
  const answered = reviewStore.getAnsweredInputRequests(projectId);
  if (answered.length > 0) {
    logInfo(TAG, `Project ${projectId}: ${answered.length} input(s) answered — resuming execution`);
    reviewStore.clearInputNotice(projectId);
    // The resume transition re-opens execution; the following case creation
    // owns the review_round advance (a fresh read bumps exactly once).
    reviewStore.stateTransition(projectId, ["needs_input"], "executing");
    return "transitioned";
  }
  const pending = reviewStore.getPendingInputRequests().filter(r => r.project_card_id === projectId);
  if (pending.length > 0) return "owned";
  logWarn(TAG, `Project ${projectId}: needs_input state but no pending or answered requests — falling through to the no-owner decision`);
  return "none";
}

type RepairItem = {
  id: string;
  affected_criterion_ids: string[];
  strategy: string;
  required_evidence: string;
  capabilities: string[];
  budget: { max_attempts?: number; max_tokens?: number };
};

function repairWorkerGoal(item: RepairItem): string {
  // The item marker is durable in the Worker contract goal. It lets restart
  // recovery correlate a child with one decision item even though spawnChild
  // allocates the final card/contract IDs itself.
  return `Repair: ${item.strategy.slice(0, 200)} [repair-item:${item.id}]`;
}

function sameStringSet(left: readonly string[] | undefined, right: readonly string[]): boolean {
  if (!left || left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every(value => expected.has(value));
}

function hasRepairWorkerForItem(
  projectId: number,
  children: readonly KanbanCard[],
  item: RepairItem,
  supervisionService: WorkerSupervisionService,
): boolean {
  const goal = repairWorkerGoal(item);
  const legacyGoal = `Repair: ${item.strategy.slice(0, 200)}`;
  for (const child of children) {
    let contract: WorkerAcceptanceContractV1 | undefined;
    try { contract = supervisionService.getContractForCard(child.id); } catch { contract = undefined; }
    if (!contract || contract.provenance.root_card_id !== projectId) continue;
    if (contract.goal === goal) return true;
    // Existing workers created before the marker was added remain durable
    // owners. Their legacy goal is accepted only with the same root criteria,
    // so an unrelated Worker cannot satisfy a repair item by text alone.
    if (contract.goal === legacyGoal && sameStringSet(contract.supports_root_criteria, item.affected_criterion_ids)) return true;
  }
  return false;
}

function handleRepairState(projectId: number, supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore): BranchResult {
  if (supervision.state === "repair_planned") {
    const decision = reviewStore.getLatestDecisionForProject(projectId);
    if (!decision) {
      logWarn(TAG, `Project ${projectId}: repair_planned but no decision found — falling through to the no-owner decision`);
      return "none";
    }
    const parsed = JSON.parse(decision.decision_json) as { repair?: { items: RepairItem[] } };
    const items = parsed.repair?.items ?? [];
    if (items.length === 0) {
      logWarn(TAG, `Project ${projectId}: repair_planned but no repair items — falling through to the no-owner decision`);
      return "none";
    }
    const contractRow2 = reviewStore.getContractByProjectCardId(projectId);
    const rootContract = contractRow2 ? JSON.parse(contractRow2.contract_json) as { criteria: Array<{ id: string; description: string }> } : null;
    const rootCardId = (() => {
      try { return require("./tasks/kanban-board.js").resolveRootId(projectId) ?? projectId; } catch { return projectId; }
    })();
    const children = kanbanGetChildren(projectId);
    const supervisionService = new WorkerSupervisionService();
    for (const item of items) {
      const goal = repairWorkerGoal(item);
      if (hasRepairWorkerForItem(projectId, children, item, supervisionService)) {
        logInfo(TAG, `Project ${projectId}: repair worker for item ${item.id} already exists — reusing durable Worker`);
        continue;
      }
      logInfo(TAG, `Project ${projectId}: creating repair worker for item ${item.id} (criteria: ${item.affected_criterion_ids.join(",")})`);
      const criteria = rootContract?.criteria
        .filter(c => item.affected_criterion_ids.includes(c.id))
        .map(c => ({ id: c.id, description: c.description })) ?? [];
      const contract: WorkerAcceptanceContractV1 = {
        schema_version: 1,
        id: `repair_${projectId}_${item.id}_${Date.now()}`,
        digest: "",
        goal,
        criteria: criteria.length > 0 ? criteria : [{ id: "repair", description: goal }],
        expected_artifacts: [],
        verification_commands: [],
        required_capabilities: item.capabilities ?? [],
        supports_root_criteria: [...item.affected_criterion_ids],
        limits: { max_tokens: item.budget?.max_tokens },
        provenance: { root_card_id: rootCardId, card_id: 0, authored_by: "orc", created_at: new Date().toISOString() },
      };
      try {
        spin.spawnChild(projectId, { goal, source: "agent", contract, settlementOwner: "spin" });
      } catch (err) {
        logWarn(TAG, `Project ${projectId}: failed to dispatch repair worker for item ${item.id} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    reviewStore.setState(projectId, "repairing");
    return "transitioned";
  }
  if (supervision.state === "repairing") {
    const children = kanbanGetChildren(projectId);
    const allTerminal = children.length > 0 && children.every(c => KANBAN_TERMINAL_STATUSES.includes(c.status));
    if (allTerminal) {
      logInfo(TAG, `Project ${projectId}: all repair children terminal — creating new review round`);
      reviewStore.setState(projectId, "executing", { repair_round: supervision.repair_round + 1 });
      return "transitioned";
    }
    if (children.length === 0) {
      logWarn(TAG, `Project ${projectId}: repairing with no children — falling through to the no-owner decision`);
      return "none";
    }
    // recoverable child rows — Reconciler/Worker dispatcher owns
    requestWorkerDispatch();
    return "owned";
  }
  return "none";
}

/**
 * #1546 R2: the existing review owner. `review_ready` without an open case is
 * Reconciler case creation (crash recovery); `review_requested`/`reviewing`
 * dispatch through the existing review request, never a fresh authoring claim.
 */
async function handleReviewState(projectId: number, supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore): Promise<void> {
  if (supervision.state === "review_ready" && !reviewStore.getLatestOpenCase(projectId)) {
    await createReviewCase(projectId, supervision, reviewStore, 0);
    return;
  }
  const openCase = reviewStore.getLatestOpenCase(projectId);
  if (!openCase) return; // no open case — the inspection classifies this as none
  const existingReq = reviewStore.getReviewRequestByCaseId(openCase.id);
  if (!existingReq) {
    const { id: rrId } = reviewStore.insertReviewRequest(projectId, openCase.id, supervision.generation);
    scheduleOrcReview(projectId, supervision.generation, openCase.id, rrId);
  } else if (existingReq.status === "pending") {
    scheduleOrcReview(projectId, supervision.generation, openCase.id, existingReq.id);
  } else if (existingReq.status === "abandoned") {
    logWarn(TAG, `Project ${projectId}: review request abandoned — settling blocked`);
    reviewStore.settleBlocked(projectId, openCase.id, { action: "blocked", reason: "Review request abandoned (attempts/deadline)" }, "Review abandoned");
    try { nerve.fire("card:failed", projectId); } catch {}
  }
}

/**
 * #1604 R2 + #1605 R3: the coverage lifecycle gate, evaluated inside
 * createReviewCase before the executing → review_ready transition. Returns:
 *  - "blocked"    → project settled terminal (undeterminable/missing contract
 *                   only — a readable semantic gap is never a terminal gate)
 *  - "waiting"    → coverage round claimed/dispatched, or another wake owns it;
 *                   project stays executing and remains spawn-eligible
 *  - "reviewable" → proceed to review_ready (clean, or gap persisted after the
 *                   bounded remediation turn — the Orc decides the gap)
 *
 * The gate rides existing reconciler wakes — no timers, no heartbeat. The
 * scheduled path's live Orc run row (orc_claim) suppresses re-entry while the
 * coverage turn runs; the non-scheduled legacy dispatch is bounded by
 * COVERAGE_ROUND_GRACE_MS instead, since it creates no observable claim.
 */
function runCoverageGate(projectId: number, supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore): "blocked" | "waiting" | "reviewable" {
  const coverage = readProjectCriterionCoverage(projectId);

  // 1. Undeterminable or missing root contract — fail closed, never "covered".
  if (coverage.kind === "undeterminable") {
    settleCoverageBlocked(projectId, reviewStore, `coverage_undeterminable: ${coverage.reason}`);
    return "blocked";
  }
  if (coverage.kind === "no_project_contract") {
    settleCoverageBlocked(projectId, reviewStore, "coverage_undeterminable: no project contract");
    return "blocked";
  }

  const uncovered = coverage.read.uncovered;
  const signature = coverageSignature(
    kanbanGetChildren(projectId).map(c => c.id),
    uncovered,
  );

  // 2. Fully covered — record the clean evaluation and proceed.
  if (uncovered.length === 0) {
    reviewStore.recordCoverageClear(projectId, signature);
    return "reviewable";
  }

  // 3. Gap — bounded remediation turn, then review with the persisted gap.
  // The round cap is a loop guard only: an exhausted cap means the gap reaches
  // review immediately (repair re-entry cannot restart coverage looping).
  if (supervision.coverage_rounds >= MAX_COVERAGE_ROUNDS) {
    if (reviewStore.recordCoverageReviewable(projectId, signature, uncovered)) {
      logInfo(TAG, `Project ${projectId}: coverage round cap reached (${uncovered.join(", ")}) — proceeding to review_ready`);
      return "reviewable";
    }
    return "waiting";
  }

  if (supervision.coverage_signature === signature) {
    const elapsed = Date.now() - Date.parse(supervision.updated_at);
    if (Number.isFinite(elapsed) && elapsed >= COVERAGE_ROUND_GRACE_MS) {
      // #1605: the Orc had its coverage turn and the gap is unchanged — it is
      // an evidence gap for the review, not a terminal gate decision.
      if (reviewStore.recordCoverageReviewable(projectId, signature, uncovered)) {
        logInfo(TAG, `Project ${projectId}: coverage gap persisted for review (${uncovered.join(", ")}) — proceeding to review_ready`);
        return "reviewable";
      }
      return "waiting";
    }
    // Same signature, grace not elapsed — the Orc had its turn; wait for the
    // next wake (tight-loop guard).
    logInfo(TAG, `Project ${projectId}: coverage round ${supervision.coverage_rounds} in flight (${uncovered.join(", ")}) — waiting`);
    return "waiting";
  }

  // New signature below cap — claim one coverage round; the CAS makes
  // concurrent wakes single-claimant.
  if (!reviewStore.claimCoverageRound(projectId, signature, uncovered, MAX_COVERAGE_ROUNDS)) {
    logInfo(TAG, `Project ${projectId}: coverage round claimed by another wake — waiting`);
    return "waiting";
  }
  dispatchCoverageRound(projectId, uncovered);
  return "waiting";
}

/** #1604: freeze a project as blocked, naming the coverage fact in the reason and the durable column. */
function settleCoverageBlocked(projectId: number, reviewStore: ProjectReviewStore, reason: string, uncoveredIds?: readonly string[]): void {
  reviewStore.stateTransition(
    projectId,
    ["awaiting_contract", "executing", "review_ready", "review_requested", "reviewing", "repair_planned", "repairing", "needs_input"],
    "blocked",
    {
      blocked_reason: reason.slice(0, 500),
      ...(uncoveredIds !== undefined ? { coverage_uncovered_ids: JSON.stringify(uncoveredIds) } : {}),
    },
  );
  // Match every other terminal blocked path (abortProject, settleBlocked):
  // the supervision row alone would leave a non-scheduled card running
  // forever. Scheduled roots are failed again by the settler — kanbanFail is
  // idempotent for an already-failed card.
  kanbanFail(projectId, reason.slice(0, 1000));
  logWarn(TAG, `Project ${projectId}: coverage gate blocked — ${reason}`);
}

/** #1604/#1605: dispatch the Orc coverage turn — coordinator for scheduled roots, legacy dispatch otherwise. */
function dispatchCoverageRound(projectId: number, uncovered: readonly string[]): void {
  const goal = `[COVERAGE GAP] Scheduled project #${projectId}: delegated root criteria ${uncovered.join(", ")} have no Worker mapped to them. Spawn a Worker to map any that should be delegated, or leave the gap for the imminent quality review if it cannot or should not be covered (e.g. the evidence came from another lane, or the criterion is being covered by Orc synthesis). Never spawn a Worker for Orc-owned criteria. Do not re-author the contract. Do not write the final report artifact yet.`;
  const card = kanbanGetCard(projectId);
  if (card && isScheduledProjectRoot(card)) {
    const coordinator = getOrCreateOrcCoordinator();
    if (!coordinator) {
      logWarn(TAG, `Project ${projectId}: Orc coordinator unavailable for coverage round — waiting for the next wake`);
      return;
    }
    const claim = coordinator.scheduleScheduledProject(projectId, goal);
    if (claim.kind === "claimed" || claim.kind === "idempotent" || claim.kind === "busy") {
      logInfo(TAG, `Project ${projectId}: coverage round dispatched to scheduled Orc (${uncovered.join(", ")})`);
    } else {
      logWarn(TAG, `Project ${projectId}: coverage round claim ${claim.kind} (${claim.reason}) — waiting for the next wake`);
    }
  } else {
    legacyOrcDispatch(goal, projectId);
    logInfo(TAG, `Project ${projectId}: coverage round dispatched via legacy Orc (${uncovered.join(", ")})`);
  }
}

/**
 * #1546: the Reconciler's review case creation for a project whose direct
 * children are all terminal. `roundOffset` is 0 when the review round was
 * already advanced by a preceding transition (e.g. input resume), 1 otherwise.
 *
 * #1604 R2: coverage is gated here, BEFORE the executing → review_ready
 * transition, so an uncovered project never enters an acceptance review it
 * structurally cannot pass. Evaluation is fail-closed: an undeterminable read
 * blocks the project; a gap dispatches a bounded coverage round to the Orc.
 * The gate runs only when entering review_ready from `executing` — the
 * `review_ready` crash-recovery path (roundOffset 0) has already passed the
 * gate, and `claimCoverageRound` pins `state = 'executing'`, so a gap there
 * could never be claimed and would stall recovery forever.
 */
async function createReviewCase(projectId: number, supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore, roundOffset: 0 | 1 = 1): Promise<void> {
  if (supervision.state === "executing") {
    const coverageGate = runCoverageGate(projectId, supervision, reviewStore);
    if (coverageGate === "waiting" || coverageGate === "blocked") return;
  }

  const nextRound = supervision.review_round + roundOffset;
  const transitioned = reviewStore.stateTransition(
    projectId,
    ["executing", "review_ready"] as ProjectState[],
    "review_ready",
    { review_round: nextRound },
  );
  if (!transitioned) {
    logWarn(TAG, `Project ${projectId}: failed to transition to review_ready`);
    return;
  }

  const assembler = new ReviewCaseAssembler();
  const snapshot = await assembler.assembleCase(projectId, supervision.generation, nextRound);
  if ("error" in snapshot) {
    logWarn(TAG, `Project ${projectId}: review case assembly failed — ${snapshot.error}`);
    return;
  }

  const snapshotDigest = `rc_${projectId}_${supervision.generation}_${nextRound}`;
  let caseId = "";
  let reviewRequestId = "";
  reviewStore.db.transaction(() => {
    const { id: cId } = reviewStore.insertReviewCase(projectId, supervision.generation, nextRound, snapshot, snapshotDigest);
    caseId = cId;
    const transitioned2 = reviewStore.stateTransition(projectId, ["review_ready"] as ProjectState[], "review_requested");
    if (!transitioned2) throw new Error(`failed to transition project ${projectId} to review_requested`);
    const { id: rrId } = reviewStore.insertReviewRequest(projectId, cId, supervision.generation);
    reviewRequestId = rrId;
  });
  logInfo(TAG, `Project ${projectId}: review ready — case ${caseId} created, request ${reviewRequestId} (gen=${supervision.generation}, round=${nextRound})`);
  logSwarmTrace({ event: "review_case_created", project: projectId, card: projectId, reviewCase: caseId, reason: "all_children_terminal", generation: supervision.generation });
  scheduleOrcReview(projectId, supervision.generation, caseId, reviewRequestId);
}

/**
 * #1546: the single state-aware project driver. Accepts a running root or a
 * queued due scheduled root; a future-dated queued root is a no-op. The driver
 * decides from durable rows whether existing work resumes, whether a scheduled
 * Orc continuation must be claimed, or whether the existing terminal authority
 * settles the occurrence as a last resort. State transitions made during one
 * pass are followed by a fresh durable read before selecting the next owner.
 */
async function reconcileProject(projectId: number): Promise<void> {
  let project = kanbanGetCard(projectId);
  if (!project) return;
  if (project.status !== "running" && !(project.status === "queued" && isScheduledProjectRoot(project) && isRetryDue(project))) return;

  const reviewStore = new ProjectReviewStore();
  const hasRootContract = reviewStore.contractExists(projectId);
  const contractRow = hasRootContract ? reviewStore.getContractByProjectCardId(projectId) : undefined;

  const now = Date.now();

  if (contractRow) {
    try {
      const contract = JSON.parse(contractRow.contract_json) as { limits?: { hard_deadline_at?: string } };
      const configuredDeadline = contract.limits?.hard_deadline_at ? Date.parse(contract.limits.hard_deadline_at) : NaN;
      if (Number.isFinite(configuredDeadline) && now > configuredDeadline) {
        await abortProject(projectId, kanbanGetChildren(projectId), "configured hard deadline exceeded");
        return;
      }
    } catch (err) {
      logWarn(TAG, `Project ${projectId}: invalid root contract deadline: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!hasRootContract) {
    const supervision = reviewStore.getSupervision(projectId);
    if (!supervision) {
      reviewStore.ensureAwaitingContract(projectId);
      logInfo(TAG, `Project ${projectId}: awaiting contract — dispatching Orc authoring turn`);
      if (isScheduledRootIdentity(project)) {
        const owned = scheduleContractAuthoringOrSettle(projectId);
        if (project.status === "queued" && owned) kanbanPromoteDueRetry(projectId);
      } else {
        legacyOrcDispatch(`Define acceptance contract for project #${projectId}; call define_project_contract with project_card_id=${projectId}`, projectId);
      }
    } else if (supervision.state === "awaiting_contract") {
      logInfo(TAG, `Project ${projectId}: still awaiting contract — waking Orc`);
      if (isScheduledRootIdentity(project)) {
        const owned = scheduleContractAuthoringOrSettle(projectId);
        if (project.status === "queued" && owned) kanbanPromoteDueRetry(projectId);
      } else {
        legacyOrcDispatch(`Define acceptance contract for project #${projectId}; call define_project_contract with project_card_id=${projectId}`, projectId);
      }
    }
    // #1546 R4: a retried queued root is promoted only after the authoring
    // owner decision above.
    if (project.status === "queued" && !isScheduledRootIdentity(project)) kanbanPromoteDueRetry(projectId);
    return;
  }

  const supervision = reviewStore.getSupervision(projectId);
  if (!supervision) {
    logWarn(TAG, `Project ${projectId}: root contract exists but no supervision state — initializing`);
    if (contractRow) {
      reviewStore.initializeSupervision(projectId, contractRow.id);
    }
    return;
  }

  if (supervision.state === "accepted" || supervision.state === "blocked") return;
  if (supervision.state === "awaiting_contract") {
    logInfo(TAG, `Project ${projectId}: still awaiting contract — waking Orc`);
    if (isScheduledRootIdentity(project)) {
      const owned = scheduleContractAuthoringOrSettle(projectId);
      if (project.status === "queued" && owned) kanbanPromoteDueRetry(projectId);
    } else {
      legacyOrcDispatch(`Define acceptance contract for project #${projectId}; call define_project_contract with project_card_id=${projectId}`, projectId);
      if (project.status === "queued") kanbanPromoteDueRetry(projectId);
    }
    return;
  }

  // ── #1546: owner-driven loop with fresh durable reads per pass ──────────
  for (let pass = 0; pass < 4; pass++) {
    project = kanbanGetCard(projectId);
    if (!project) return;
    if (project.status !== "running" && !(project.status === "queued" && isScheduledProjectRoot(project) && isRetryDue(project))) return;

    const supervision = reviewStore.getSupervision(projectId);
    if (!supervision) return;
    if (supervision.state === "accepted" || supervision.state === "blocked") return;

    if (project.max_tokens != null && (project.tokens_used ?? 0) >= project.max_tokens) {
      await abortProject(projectId, kanbanGetChildren(projectId), `budget exceeded (${project.tokens_used}/${project.max_tokens} tokens)`);
      return;
    }

    if (project.status === "queued") {
      // #1546 R4: claim-before-promotion — only when no durable owner exists.
      // A crash between the Orc claim and the card write leaves queued+due,
      // which the next wake observes as already owned and promotes.
      if (inspectProjectOwnership(projectId, supervision, reviewStore) === "none") {
        if (claimScheduledContinuation(projectId, supervision, reviewStore, project) === "settled") return;
      }
      if (!kanbanPromoteDueRetry(projectId)) return; // lost the conditional race — next wake re-reads
      continue;
    }

    switch (inspectProjectOwnership(projectId, supervision, reviewStore)) {
      case "terminal":
        return;
      case "worker_resume":
        requestWorkerDispatch();
        return;
      case "orc_claim":
        return; // existing live Orc row owns the project
      case "review":
        await handleReviewState(projectId, supervision, reviewStore);
        return;
      case "input": {
        const result = handleInputState(projectId, supervision, reviewStore);
        if (result === "transitioned" || result === "none") continue;
        return; // pending input owned by the input dispatcher
      }
      case "repair": {
        const result = handleRepairState(projectId, supervision, reviewStore);
        if (result === "transitioned" || result === "none") continue;
        return; // recoverable children owned by the Worker path
      }
      case "executing_terminal_children":
        await createReviewCase(projectId, supervision, reviewStore, 1);
        return;
      case "none":
        // #1546: the scheduled Orc continuation and last-resort settlement
        // apply to scheduled roots only; generic unscheduled O cards retain
        // their current fallback behavior (no claim, no freeze).
        if (!isScheduledProjectRoot(project)) return;
        // At most one correlated claim per wake: the coordinator's live row
        // (or a re-derived owner) is re-read on the next wake. The queued
        // branch promotes first and continues so the state owner still runs.
        if (claimScheduledContinuation(projectId, supervision, reviewStore, project) === "settled") return;
        return; // the claim (or its re-derived owner) now owns the project
    }
  }
}

function dispatchPendingReviewRequests(): number {
  const store = new ProjectReviewStore();
  const pending = store.getPendingReviewRequests();
  let dispatched = 0;
  for (const req of pending) {
    if (_orcCoordinator) {
      const result = _orcCoordinator.scheduleReview(req.project_card_id, req.generation, req.review_case_id);
      if (result.kind === "claimed" || result.kind === "idempotent") {
        try { store.bumpReviewRequestAttempt(req.id); } catch {}
        dispatched++;
      }
    } else {
      legacyOrcReviewDispatch(req.project_card_id, req.generation, req.review_case_id, req.id);
      dispatched++;
    }
  }
  return dispatched;
}

// ── #1405: Pi executor lane ──────────────────────────────────────────────────

function reconcilePiCard(card: KanbanCard): void {
  const svc = _piService;
  if (!svc) {
    logWarn(TAG, `Pi card ${card.id} queued but Pi service not available`);
    return;
  }
  if (card.status !== "queued") return;
  if (!isUnblocked(card)) return;

  if (svc.executor.activeCount >= svc.executor.maxConcurrent) {
    logInfo(TAG, `Pi card ${card.id} queued but Pi capacity full (${svc.executor.activeCount}/${svc.executor.maxConcurrent})`);
    return;
  }

  const run = svc.store.getByCardId(card.id);
  if (!run) {
    logWarn(TAG, `Pi card ${card.id} has no associated Pi run`);
    return;
  }
  if (run.status !== "queued") {
    logWarn(TAG, `Pi card ${card.id} run ${run.id} status is ${run.status} not queued`);
    return;
  }

  const claim = svc.store.claimQueuedGeneration(card.id);
  if (!claim.claimed) {
    logWarn(TAG, `Failed to claim Pi card ${card.id}: ${claim.reason}`);
    return;
  }

  logInfo(TAG, `Starting Pi run ${claim.runId} (card ${card.id}, gen ${claim.generation})`);
  svc.executor.startWithClaim(claim.runId, claim.generation, run.currentSessionId ?? `${Date.now()}_C_pi_${claim.runId}`).catch((err) => {
    logWarn(TAG, `Pi start failed for ${claim.runId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function reconcileChildCard(card: KanbanCard): Promise<void> {
  if (card.type === "pi") {
    reconcilePiCard(card);
    return;
  }

  const svc = new WorkerSupervisionService();
  const hasContract = svc.cardHasContract(card.id);
  if (!hasContract) return;

  const latestAttempt = getLatestAttemptInfo(card.id);

  if (card.status === "queued") {
    if (!isUnblocked(card)) return;
    if (latestAttempt && latestAttempt.lifecycle === "pending") {
      requestWorkerDispatch();
    }
    return;
  }

  if (card.status === "failed" && latestAttempt) {
    handleSupervisedRetry(card, latestAttempt.lifecycle);
    return;
  }

  if (latestAttempt && !isTerminal(latestAttempt.lifecycle)) {
    evaluateLease(card);
    return;
  }

  if (latestAttempt && latestAttempt.lifecycle === "cancel_requested") {
    return;
  }
}

export function requestWorkerDispatch(): void {
  dispatchPumpState.dirty = true;
  if (!dispatchPumpState.running) {
    dispatchPumpState.running = true;
    queueMicrotask(() => runWorkerDispatch());
  }
}

interface DispatchPumpState {
  running: boolean;
  dirty: boolean;
}

const dispatchPumpState: DispatchPumpState = { running: false, dirty: false };

async function runWorkerDispatch(): Promise<void> {
  try {
    do {
      dispatchPumpState.dirty = false;
      if (_shutdownRequested) return;
      await dispatchOnePass();
    } while (dispatchPumpState.dirty);
  } finally {
    dispatchPumpState.running = false;
  }
}

async function dispatchOnePass(): Promise<void> {
  const store = new WorkerSupervisionStore();
  const capacities = new Map<string, { adapter: SwarmExecutorAdapter; max: number }>();
  const rootDeadlines = new Map<number, string | undefined>();

  const queued = kanbanQueuedDispatchOrder();
  for (const card of queued) {
    if (_shutdownRequested) return;

    if (!isUnblocked(card)) continue;
    if (card.parent_id == null) continue;
    const projectId = card.parent_id;

    const project = kanbanGetCard(projectId);
    if (!project || project.status !== "running") continue;

    const supSvc = new WorkerSupervisionService();
    const hasContract = supSvc.cardHasContract(card.id);
    if (!hasContract) continue;

    const latestAttempt = store.getLatestAttempt(card.id);
    if (!latestAttempt || latestAttempt.lifecycle !== "pending") continue;

    const executor = dispatchExecutor(latestAttempt.executor_kind ?? "local_worker", latestAttempt.executor_id ?? "spin");
    if (!executor) continue;
    const capacityKey = `${executor.kind}:${executor.id}`;
    let capacity = capacities.get(capacityKey);
    if (!capacity) {
      const snapshot = await executor.adapter.capacity();
      capacity = { adapter: executor.adapter, max: snapshot.max };
      capacities.set(capacityKey, capacity);
    }
    if (capacity.max <= 0) continue;
    if (store.getActiveAttemptCountForExecutor(executor.kind, executor.id) >= capacity.max) continue;

    if (latestAttempt.source_attempt_id) {
      if (latestAttempt.earliest_claim_at && new Date(latestAttempt.earliest_claim_at).getTime() > Date.now()) {
        continue;
      }
    }

    const contract = supSvc.getContractForCard(card.id);
    if (!contract) continue;

    const rootHardDeadline = rootDeadlines.get(projectId) ?? (() => {
      const row = new ProjectReviewStore().getContractByProjectCardId(projectId);
      let deadline: string | undefined;
      if (row) {
        try {
          const root = JSON.parse(row.contract_json) as { limits?: { hard_deadline_at?: string } };
          deadline = root.limits?.hard_deadline_at;
        } catch (err) {
          logWarn(TAG, `Invalid root contract for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      rootDeadlines.set(projectId, deadline);
      return deadline;
    })();
    const executorMax = capacity.max;
    const policy = resolveSchedulingPolicy(executor.kind);
    const workerMaxDurationMs = contract.limits?.max_duration_ms;
    const claimedAt = new Date().toISOString();
    const hardDeadlineAt = deriveDeadline(claimedAt, policy, rootHardDeadline, workerMaxDurationMs);

    const reservedTokens = (project.max_tokens != null && contract.limits?.max_tokens != null)
      ? Number(contract.limits.max_tokens)
      : 0;

    const result = store.claimAttemptWithinLimits({
      cardId: card.id,
      attemptId: latestAttempt.id,
      contractId: contract.id,
      executorKind: executor.kind,
      executorId: executor.id,
      generation: latestAttempt.generation || 1,
      executorMax,
      hardDeadlineAt,
      reservedTokens,
      projectId,
      sourceAttemptId: latestAttempt.source_attempt_id ?? undefined,
    });

    logSwarmTrace({
      event: "dispatch_selected",
      card: card.id,
      attempt: latestAttempt.id,
      reason: result.kind,
    });

    if (result.kind === "budget_exhausted") {
      store.terminalSettlement({
        attemptId: latestAttempt.id,
        expectedGeneration: latestAttempt.generation || 1,
        desiredState: "cancelled",
        stableReason: "budget_exhausted",
      });
      // #1590: the transition owns error + completed_at + the card:failed
      // event the old kanbanFail call emitted. attemptId/generation correlate
      // the journal row to the worker_attempt that was refused. The store's
      // own TaskDatabase is passed explicitly — never the module singleton,
      // so out-of-process or mocked contexts stay on the right connection.
      kanbanTransition({
        cardId: card.id,
        from: ["queued", "running"],
        to: "failed",
        actor: "budget_enforcement",
        reason: "budget_exhausted",
        attemptId: latestAttempt.id,
        claimGeneration: latestAttempt.generation || 1,
        fields: { error: "budget_exhausted", completed_at: sqliteNow() },
      }, store.db);
      continue;
    }

    if (result.kind !== "claimed") continue;
    const claim = (result as { kind: "claimed"; claim: ExecutionClaim }).claim;
    if (!store.markAttemptStartObservable(claim.attemptId)) {
      store.terminalSettlement({
        attemptId: claim.attemptId,
        expectedGeneration: claim.generation,
        desiredState: "failed",
        stableReason: "could not enter starting state",
      });
      kanbanFail(card.id, "could not enter starting state");
      continue;
    }

    logSwarmTrace({ event: "worker_claim", card: card.id, attempt: claim.attemptId, generation: claim.generation, executor: claim.executorId });

    let observation;
    try {
      observation = await executor.adapter.start(claim);
    } catch (err) {
      observation = { kind: "start_failed" as const, reason: String(err), retryable: true };
    }

    if (observation.kind === "started" || observation.kind === "already_started") {
      store.markAttemptRunning(claim.attemptId);
      logSwarmTrace({ event: "worker_started", card: card.id, attempt: claim.attemptId, generation: claim.generation, executor: claim.executorId });
    } else {
      logSwarmTrace({ event: "worker_start_failed", card: card.id, attempt: claim.attemptId, reason: "start_failed" });
      store.terminalSettlement({
        attemptId: claim.attemptId,
        expectedGeneration: claim.generation,
        desiredState: "failed",
        stableReason: `start_failed: ${observation.reason}`,
      });
      kanbanFail(card.id, `worker start failed: ${observation.reason}`);
    }

  }
}

function isTerminal(lc: AttemptLifecycle): boolean {
  return lc === "completed" || lc === "failed" || lc === "cancelled" || lc === "timed_out";
}

function evaluateLease(card: KanbanCard): void {
  try {
    const supStore = new WorkerSupervisionStore();
    const latestAttempt = supStore.getLatestAttempt(card.id);
    if (!latestAttempt) return;

    const adapterResolver = (executorKind: string, _executorId: string) => {
      if (executorKind === "agent") return workerAdapter();
      if (executorKind === "pi") {
        const svc = _piService;
        if (!svc) return undefined;
        const { PiExecutorAdapter } = require("./pi-executor-adapter.js") as typeof import("./pi-executor-adapter.js");
        return new PiExecutorAdapter(svc.executor);
      }
      return undefined;
    };

    const service = new LeaseReconciliationService(adapterResolver);
    service.evaluateAndAct(latestAttempt.id, card.id);
    scheduleLeaseEvaluations();
  } catch (err) {
    logWarn(TAG, `lease evaluation failed for card ${card.id}: ${err}`);
  }
}
function handleSupervisedRetry(card: KanbanCard, lifecycle: AttemptLifecycle): void {
  if (lifecycle !== "failed" && lifecycle !== "cancelled" && lifecycle !== "timed_out") return;

  try {
    const supStore = new WorkerSupervisionStore();
    const latestAttempt = supStore.getLatestAttempt(card.id);
    if (!latestAttempt) {
      logWarn(TAG, `handleSupervisedRetry: no attempt for ${card.id} — leaving card failed for Orc review`);
      return;
    }

    const retryService = buildRetryService();

    const result = retryService.reduceTerminalAttempt(latestAttempt.id, card.id);
    if ("error" in result) {
      logWarn(TAG, `retry classification failed for ${card.id}: ${result.error} — leaving card failed for Orc review`);
      return;
    }

    const { classification, decision } = result;

    switch (decision.disposition) {
      case "automatic_retry": {
        const acceptResult = retryService.acceptAutomaticRetry(latestAttempt.id, card.id);
        if (acceptResult.kind === "created") {
          logInfo(TAG, `Auto-retry card ${card.id}: attempt ${latestAttempt.ordinal} -> ${acceptResult.targetAttemptId} (${classification.primary})`);
          wakeCard(card.id);
        } else if (acceptResult.kind === "idempotent") {
          logInfo(TAG, `Auto-retry already scheduled for card ${card.id}: target ${acceptResult.targetAttemptId}`);
          wakeCard(card.id);
        } else {
          logWarn(TAG, `Auto-retry failed for card ${card.id}: ${acceptResult.kind} — leaving card failed`);
        }
        break;
      }
      case "orc_review": {
        logInfo(TAG, `Orc review required for card ${card.id}: attempt ${latestAttempt.id} (${classification.primary})`);
        break;
      }
      case "needs_input": {
        logInfo(TAG, `Needs input for card ${card.id}: attempt ${latestAttempt.id} (${classification.primary})`);
        break;
      }
      case "stop": {
        logInfo(TAG, `Stopping retry for card ${card.id}: ${decision.reasonCode}`);
        cascadeFail(card.id, kanbanGetChildren(card.parent_id ?? 0));
        break;
      }
    }
  } catch (err) {
    logWarn(TAG, `handleSupervisedRetry error for ${card.id}: ${err} — leaving card failed for Orc review`);
  }
}

function buildRetryService(): import("./retry/retry-service.js").RetryService {
  const { RetryService } = require("./retry/retry-service.js") as typeof import("./retry/retry-service.js");
  const { LocalExecutorCatalog } = require("./retry/local-executor-catalog.js") as typeof import("./retry/local-executor-catalog.js");
  const { providerForAdapter } = require("./retry/local-executor-catalog.js") as typeof import("./retry/local-executor-catalog.js");
  const catalog = new LocalExecutorCatalog({
    spinProvider: providerForAdapter(workerAdapter(), "spin"),
  });
  return new RetryService({ executorCatalog: catalog });
}

function getLatestAttemptInfo(cardId: number): AttemptRow | undefined {
  const store = new WorkerSupervisionStore();
  return store.getLatestAttempt(cardId);
}

async function abortProject(projectId: number, children: KanbanCard[], reason: string, opts?: { skipRootFail?: boolean }): Promise<void> {
  logWarn(TAG, `ABORT project ${projectId}: ${reason}`);
  // Freeze supervision before cancelling child executors. Late Orc review
  // results must not be able to move an aborted project back to accepted.
  const reviewStore = new ProjectReviewStore();
  reviewStore.stateTransition(
    projectId,
    ["awaiting_contract", "executing", "review_ready", "review_requested", "reviewing", "repair_planned", "repairing", "needs_input"],
    "blocked",
    { blocked_reason: `aborted: ${reason}`.slice(0, 500) },
  );
  const store = new WorkerSupervisionStore();
  for (const card of children) {
    if (card.status !== "running" && card.status !== "queued") continue;
    const attempt = store.getLatestAttempt(card.id);
    if (!attempt) {
      kanbanFail(card.id, `project aborted: ${reason}`);
      continue;
    }
    const settlement = store.terminalSettlement({
      attemptId: attempt.id,
      expectedGeneration: attempt.generation || 1,
      desiredState: "cancelled",
      stableReason: `project_abort: ${reason}`,
    });
    if (settlement.kind === "settled" || settlement.kind === "replayed") {
      const executor = dispatchExecutor(attempt.executor_kind, attempt.executor_id);
      if (executor) {
        await executor.adapter.cancel({
          attemptId: attempt.id,
          cardId: attempt.card_id,
          contractId: attempt.contract_id,
          executorKind: executor.kind,
          executorId: executor.id,
          generation: attempt.generation || 1,
          claimedAt: attempt.claimed_at ?? attempt.started_at,
          hardDeadlineAt: attempt.hard_deadline_at ?? undefined,
        }, "project_abort");
      }
    }
    kanbanFail(card.id, `project aborted: ${reason}`);
  }
  // #1546: the last-resort settler performs the one root card mutation after
  // winning settlement; a second root fail would emit a duplicate terminal
  // event (proved by the focused exactly-once settlement test).
  if (!opts?.skipRootFail) {
    kanbanFail(projectId, reason);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function requestReconcile(cardId: number): void {
  wakeCard(cardId);
}

export function requestReconcileForProject(cardId: number): void {
  const card = kanbanGetCard(cardId);
  if (card?.parent_id) {
    wakeCard(card.parent_id);
  }
  wakeCard(cardId);
}

export function retryPendingReviewRequests(): number {
  return dispatchPendingReviewRequests();
}

export function scanActiveProjects(): number {
  const projectIds = kanbanRunningProjectIds();
  for (const projectId of projectIds) wakeCard(projectId);
  return projectIds.length;
}

export function answerInputRequest(requestId: string, response: string): boolean {
  const store = new ProjectReviewStore();
  const answered = store.answerInputRequest(requestId, response);
  if (answered) {
    const rows = store.db.prepare(`SELECT project_card_id FROM project_input_requests WHERE id = ?`).get(requestId) as { project_card_id: number } | undefined;
    if (rows) requestReconcile(rows.project_card_id);
  }
  return answered;
}

function scheduleLeaseEvaluations(): void {
  getWakeScheduler()?.sourceChanged("executor-lease");
}

let _reconcilerStarted = false;

export function startReconciler(): void {
  if (_reconcilerStarted) {
    logInfo(TAG, "Reconciler already started — skipping duplicate init");
    return;
  }
  _reconcilerStarted = true;

  getOrCreateOrcCoordinator();

  // #1510: Boot recovery — terminalize process-bound attempts from dead bridge
  runBootRecovery();

  // #1539: executor-lease due source on the lifecycle wake scheduler.
  registerExecutorLeaseSource();

  nerve.on("card:queued", (cardId: number) => requestReconcileForProject(cardId));
  nerve.on("card:done", (cardId: number) => requestReconcileForProject(cardId));
  nerve.on("card:failed", (cardId: number) => requestReconcileForProject(cardId));
  const count = scanActiveProjects();

  logInfo(TAG, `Reconciler started — recovered ${count} running project(s)`);
}

function leaseWake(cardId: number): void {
  const card = require("./tasks/kanban-board.js").kanbanGetCard(cardId) as { parent_id?: number } | undefined;
  if (card?.parent_id) wakeCard(card.parent_id);
  requestReconcile(cardId);
}

/** #1539: register the executor-lease due source with the wake scheduler. */
function registerExecutorLeaseSource(): void {
  const scheduler = getWakeScheduler();
  if (!scheduler) {
    logWarn(TAG, "Lease source not registered — lifecycle wake scheduler unavailable");
    return;
  }
  const { ExecutorLeaseStore: StoreWithHook } = require("./executor-lease-store.js") as typeof import("./executor-lease-store.js");
  scheduler.register({
    id: "executor-lease",
    listDueItems: () => new ExecutorLeaseStore().getEvaluationSchedule()
      .map(s => ({ key: `lease:${s.attemptId}`, dueAt: new Date(s.nextEvaluationAt).getTime() })),
    wakeDue: (_now: number) => {
      for (const s of new ExecutorLeaseStore().getDueSnapshots()) {
        leaseWake(s.cardId);
      }
    },
  });
  StoreWithHook.onLeaseChanged = () => {
    scheduler.sourceChanged("executor-lease");
    const cardId = StoreWithHook.lastChangedCardId;
    if (cardId !== undefined) projectRunProgress(cardId);
  };
  // Registration is a source mutation: immediate scan + re-arm.
  scheduler.sourceChanged("executor-lease");
}

let _wakeScheduler: LifecycleWakeScheduler | null = null;

export function setWakeScheduler(scheduler: LifecycleWakeScheduler | null): void {
  _wakeScheduler = scheduler;
}

export function getWakeScheduler(): LifecycleWakeScheduler | null {
  return _wakeScheduler;
}

/** #1539: project lease milestones into the owning scheduled run's progress. */
let _runProgressBridge: ((cardId: number) => void) | null = null;
export function setRunProgressBridge(bridge: ((cardId: number) => void) | null): void {
  _runProgressBridge = bridge;
}

/** #1588: the failure cascade callback, wired from boot for last-resort settlements. */
let _failureCascade: ((entryId: string, diagnostic: TaskFailureDiagnosticV1) => void) | undefined;
export function setFailureCascade(fn: ((entryId: string, diagnostic: TaskFailureDiagnosticV1) => void) | undefined): void {
  _failureCascade = fn;
}
function projectRunProgress(cardId: number): void {
  try {
    _runProgressBridge?.(cardId);
  } catch (err) {
    logWarn(TAG, `run progress bridge failed for card ${cardId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function runBootRecovery(): void {
  try {
    const store = new WorkerSupervisionStore();
    const active = store.getActiveSupervisedAttempts();
    if (active.length === 0) {
      logInfo(TAG, "Boot recovery: no active attempts to recover");
      return;
    }

    let recovered = 0;
    for (const attempt of active) {
      const policy = resolveSchedulingPolicy(attempt.executor_kind);
      if (policy.recovery === "process_bound") {
        const bootResult = store.terminalSettlement({
          attemptId: attempt.id,
          expectedGeneration: attempt.generation || 1,
          desiredState: "timed_out",
          stableReason: "bridge_restart",
        });
        if (bootResult.kind === "settled" || bootResult.kind === "budget_violation") {
          logSwarmTrace({ event: "recovery_settled", card: attempt.card_id, attempt: attempt.id, generation: attempt.generation, reason: "bridge_restart" });
          const card = kanbanGetCard(attempt.card_id);
          if (card) kanbanFail(card.id, "bridge_restart");
        }
        recovered++;
      } else if (policy.recovery === "inspectable") {
        const adapter = resolveAdapterForRecovery(attempt.executor_kind, attempt.executor_id);
        if (adapter) {
          const claim: ExecutionClaim = {
            attemptId: attempt.id,
            cardId: attempt.card_id,
            contractId: attempt.contract_id,
            executorKind: attempt.executor_kind as "agent" | "pi",
            executorId: attempt.executor_id,
            generation: attempt.generation || 1,
            claimedAt: attempt.claimed_at ?? attempt.started_at,
            hardDeadlineAt: attempt.hard_deadline_at ?? undefined,
          };
          adapter.inspect(claim).then(observation => {
            if (observation.kind === "terminal") {
              store.terminalSettlement({
                attemptId: attempt.id,
                expectedGeneration: attempt.generation || 1,
                desiredState: observation.lifecycle as "completed" | "failed" | "cancelled" | "timed_out",
                stableReason: "recovery_inspection_terminal",
              });
            }
          }).catch(err => {
            logWarn(TAG, `Boot recovery inspection failed for ${attempt.id}: ${err instanceof Error ? err.message : String(err)}`);
          });
          logSwarmTrace({ event: "recovery_inspect", card: attempt.card_id, attempt: attempt.id, reason: "inspectable_attempt" });
        }
      }
    }
    if (recovered > 0) {
      logInfo(TAG, `Boot recovery: settled ${recovered} process-bound attempt(s)`);
    }
  } catch (err) {
    logWarn(TAG, `Boot recovery error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function resolveAdapterForRecovery(executorKind: string, _executorId: string): SwarmExecutorAdapter | undefined {
  if (executorKind === "agent") return workerAdapter();
  if (executorKind === "pi") {
    const svc = _piService;
    if (!svc) return undefined;
    const { PiExecutorAdapter } = require("./pi-executor-adapter.js") as typeof import("./pi-executor-adapter.js");
    return new PiExecutorAdapter(svc.executor);
  }
  return undefined;
}
