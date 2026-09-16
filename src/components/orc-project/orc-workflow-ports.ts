/**
 * orc-workflow-ports.ts — #1792 Task 5: execution and model-job ports.
 *
 * Runner-private implementation (covered by scripts/check-orc-authority.mjs
 * RUNNER_FILES): the worker port creates supervised children through the
 * retained WorkerSupervisionService primitives, and the planner/reviewer
 * backends invoke bounded model one-shots through an injected callModel
 * (production: spin.dispatchBackground; tests: fakes). Model sessions never
 * own project liveness: every backend outcome returns through runner ingress
 * (submitPlanProposal / submitVerdict / failJobCommand).
 *
 * Executor routing stays in existing machinery: the contract-derived intent
 * resolver picks the executor at child creation, and the reconciler dispatch
 * pump starts pending attempts (capacity/backpressure unchanged). The port
 * only creates the child, binds it to the node, and wakes the pump.
 *
 * Pi transport portability (#1792 Task 5, #1638): the Pi worker port mirrors
 * the Spin worker port's creation/binding sequence with a workspace alias so
 * the contract-derived intent resolver picks pi/pi-coding; the existing
 * PiExecutorAdapter boundary (via the reconciler dispatch pump) starts the
 * attempt, binds the Pi run resource, and settles through
 * SupervisedPiSettlement. Capability routing is minimal and explicit (below):
 * a node whose spec.capability names Pi goes to the Pi port, Spin default
 * otherwise. The plan schema carries no alias field, so a Pi capability that
 * is itself a configured Pi workspace alias carries the workspace; a generic
 * Pi capability (pi-coding/pi) resolves to the first configured alias.
 */
import { ProjectReviewStore, authorizeActiveProjectWork } from "../project-acceptance/project-review-store.js";
import { WorkerSupervisionService } from "../worker-supervision-service.js";
import { channelPostOnce } from "../tasks/kanban-channel.js";
import { RUNNER_ROOT_RUNNING_PREDICATE, kanbanTransition, type TaskDatabase } from "../tasks/kanban-board.js";
import { loadPiConfig } from "../pi-executor/config.js";
import {
  WorkflowRunner,
  boundText,
  type DeliverySender,
  type ExecutionPort,
  type PlanDiagnostic,
  type PlanProposal,
  type PlannerBackend,
  type PlanningInput,
  type ReviewBackend,
  type ReviewBrief,
  type ReviewVerdict,
} from "./orc-workflow-runner.js";
import type { CommandRow, RunnerRootRunRef } from "./orc-workflow-store.js";

/** Dispatch failures fail the node visibly (bounded); never wedge the drain. */
export class WorkflowDispatchError extends Error {
  readonly nodeId: string;
  constructor(nodeId: string, message: string) {
    super(message);
    this.name = "WorkflowDispatchError";
    this.nodeId = nodeId;
  }
}

export interface ModelCall {
  (prompt: string, timeoutMs: number): Promise<string>;
}

const PLANNER_TIMEOUT_MS = 300_000;
const REVIEWER_TIMEOUT_MS = 300_000;

function planPrompt(input: {
  goal: string; requiredOutputs: string[]; capabilities: string[];
  priorResults: string; attempt: number; problem?: string;
  workspace: string | null;
}): string {
  return [
    "You are a work planner. Decompose the goal into a parallelizable work graph.",
    "Respond with NOTHING but a single JSON object (no markdown fences, no prose):",
    '{"nodes":[{"label":"short-id","kind":"work|synthesis","instructions":"...","capability":"...","outputs":["..."],"acceptance":["..."],"dependsOn":["..."],"optional":false}],"requiredOutputs":["..."],"allowPartial":false}',
    "Rules: every work/synthesis node needs non-empty instructions, capability (one of: "
      + `${input.capabilities.join(", ")}), outputs, acceptance, and dependsOn (possibly empty).`,
    // #1804: the capability menu is the model-facing vocabulary only — bare
    // Pi workspace aliases are never offered. Execution semantics: ordinary
    // research, collection, writing, and synthesis run on the general agent
    // lane; pi-coding/pi request the intentional coding executor. Writing
    // files or having a workspace root does not imply coding.
    "Capability semantics: general is ordinary agent work (research, collection, writing, synthesis); pi-coding/pi request the coding executor for deliberate coding work, including in scheduled workflows. Use general unless the node genuinely needs code execution.",
    "Never emit a bare workspace alias (for example default) as a capability — only the listed vocabulary is accepted; an alias proposal is rejected through the correction path, never silently rewritten.",
    "Labels unique. Dependencies must reference declared labels. No cycles.",
    "Every requiredOutput must be declared in some node's outputs.",
    "All outputs must be workspace-relative paths (e.g. out/report.md) — never absolute paths, never ~, never /home or /tmp prefixes. Absolute outputs are rejected.",
    "Include an explicit synthesis node when the requested output needs assembled writing.",
    ...(input.workspace !== null ? [
      `Workspace root: ${input.workspace}`,
      "Node outputs and requiredOutputs resolve against exactly that root — do not prepend any additional directory prefix. An absolute path named in the goal identifies the destination, not an extra relative prefix.",
      "Preserve the lane identity, source scope, optionality, exact artifact names, and report requirements stated in the goal verbatim.",
    ] : []),
    `Goal: ${input.goal}`,
    `Required outputs: ${input.requiredOutputs.join(", ")}`,
    input.priorResults.length > 0 ? `Prior results under revision (build on them): ${input.priorResults}` : "",
    input.attempt > 0 && input.problem
      ? `Your previous proposal was REJECTED for: ${input.problem}. Correct exactly that and return the full fixed proposal.`
      : "",
  ].filter((l) => l.length > 0).join("\n");
}

function reviewPrompt(brief: ReviewBrief): string {
  return [
    "You are a quality reviewer. Inspect the candidate output against its acceptance conditions.",
    "Respond with NOTHING but a single JSON object (no markdown fences, no prose), one of:",
    '{"verdict":"accept"}',
    '{"verdict":"changes_required","defects":[{"criterion":"<exact criterion id from below>","detail":"concrete defect"}]}',
    '{"verdict":"cannot_assess","reason":"..."}',
    "Rules: accept only if every acceptance condition is met by the ACTUAL output revision below.",
    "changes_required defects must each link an exact criterion id and describe the concrete defect.",
    "You may read the artifact files listed; do not invent evidence you did not read.",
    `Request: ${brief.request.title}`,
    // AstraMaster-8: the reviewer was never shown the goal or the criterion
    // ids, yet valid criticism requires exact ids — include both.
    `Goal: ${brief.request.goal ?? brief.request.title}`,
    `Required outputs: ${brief.requiredOutputs.join(", ")}`,
    `Acceptance criteria by node (defect criterion ids must be exact strings from this map): ${JSON.stringify(brief.criteriaByNode)}`,
    `Candidate revision: ${brief.revision}`,
    `Nodes: ${JSON.stringify(brief.nodes)}`,
    `Failures observed: ${JSON.stringify(brief.failures)}`,
    `Evidence ids: ${brief.evidenceIds.join(", ")}`,
  ].join("\n");
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("no JSON object in model response");
  }
}

/** Parse + minimally shape-check a proposal; throws a bounded diagnostic. */
function parseProposal(text: string): PlanProposal {
  const raw = extractJson(text) as Record<string, unknown>;
  if (!raw || !Array.isArray(raw["nodes"]) || !Array.isArray(raw["requiredOutputs"])) {
    throw new Error("proposal must be {nodes: [...], requiredOutputs: [...]}");
  }
  return raw as unknown as PlanProposal;
}

/** Parse + minimally shape-check a verdict; throws a bounded diagnostic. */
function parseVerdict(text: string): ReviewVerdict {
  const raw = extractJson(text) as Record<string, unknown>;
  const kind = raw?.["verdict"];
  if (kind !== "accept" && kind !== "changes_required" && kind !== "cannot_assess") {
    throw new Error('verdict must carry verdict:"accept"|"changes_required"|"cannot_assess"');
  }
  return raw as unknown as ReviewVerdict;
}

/**
 * #1799: outcome of the shared runner-root projection. A rejection is a
 * skip, never an exception: callers fail the dispatch (or skip the recovery
 * candidate) through their existing paths.
 */
export type RootProjectionOutcome = { ok: true } | { ok: false; reason: string };

const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

/**
 * #1799: shared runner-root projection — the single operation that may move
 * a runner-owned root card `queued → running`.
 *
 * The passed run is an identity, never a state snapshot: the live
 * `workflow_runs` row is re-read on the caller's connection and its
 * root-card/scheduled-run identities must match the reference. Preflight
 * reads produce useful rejection reasons; the card CAS carries the fixed
 * `RUNNER_ROOT_RUNNING_PREDICATE` so a terminal state, supervision
 * generation change, or scheduled-run completion committed before the CAS
 * wins the race (failed CAS writes neither a promotion event nor a journal
 * entry). The projection may win before a later cancellation; subsequent
 * dispatch/claim fences stay responsible for rejecting stale work.
 *
 * Called outside admission transactions and before child publication; no
 * outer transaction may publish nerve events before commit. All writes go
 * through `kanbanTransition` on the caller's connection (never the
 * global-database `kanbanRunning`).
 */
export function projectRunnerRootRunning(
  db: TaskDatabase,
  run: RunnerRootRunRef,
): RootProjectionOutcome {
  // 1. Re-read the workflow run; never trust a passed run.state.
  let live: { root_card_id: unknown; scheduled_run_id: unknown; state: unknown } | undefined;
  try {
    live = db.prepare(`SELECT root_card_id, scheduled_run_id, state FROM workflow_runs WHERE run_id = ?`)
      .get(run.runId) as { root_card_id: unknown; scheduled_run_id: unknown; state: unknown } | undefined;
  } catch (err) {
    return { ok: false, reason: `workflow run ${run.runId} unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!live) return { ok: false, reason: `workflow run ${run.runId} missing` };
  if (Number(live.root_card_id) !== run.rootCardId) {
    return { ok: false, reason: `workflow run ${run.runId} root mismatch` };
  }
  const liveScheduled = (live.scheduled_run_id as string | null) ?? null;
  const refScheduled = run.scheduledRunId ?? null;
  if (liveScheduled !== refScheduled) {
    return { ok: false, reason: `workflow run ${run.runId} scheduled-run mismatch` };
  }
  if (typeof live.state !== "string" || TERMINAL_RUN_STATES.has(live.state)) {
    return { ok: false, reason: `workflow run ${run.runId} terminal (${String(live.state)})` };
  }
  // 2. Supervision must exist for the root.
  const sup = db.prepare(`SELECT state, generation FROM project_supervision WHERE project_card_id = ?`)
    .get(run.rootCardId) as { state: string; generation: number } | undefined;
  if (!sup) return { ok: false, reason: `supervision missing for card ${run.rootCardId}` };
  // 3. Only executing/repairing supervision is evidence of executable work.
  if (sup.state !== "executing" && sup.state !== "repairing") {
    return { ok: false, reason: `supervision not executable (state ${sup.state})` };
  }
  // 4. Existing active-project authority (supervision generation, never the
  // workflow generation).
  const rejection = authorizeActiveProjectWork(db, {
    projectCardId: run.rootCardId,
    projectGeneration: Number(sup.generation),
    scheduledRunId: refScheduled ?? undefined,
  });
  if (rejection) return { ok: false, reason: `authority rejected: ${rejection}` };
  // 5. Project the card. Already-running is idempotent (no journal, no
  // event); terminal/missing cards never become running.
  const card = db.prepare(`SELECT status FROM kanban_board WHERE id = ?`)
    .get(run.rootCardId) as { status: string } | undefined;
  if (!card) return { ok: false, reason: `root card ${run.rootCardId} missing` };
  if (card.status === "running") return { ok: true };
  if (card.status !== "queued") {
    return { ok: false, reason: `root card ${run.rootCardId} not queued (state ${card.status})` };
  }
  const outcome = kanbanTransition({
    cardId: run.rootCardId,
    from: ["queued"],
    to: "running",
    actor: "dispatch",
    reason: `workflow run ${run.runId} executing`,
    extraPredicate: RUNNER_ROOT_RUNNING_PREDICATE,
    extraPredicateParams: [Number(sup.generation), run.runId, refScheduled],
  }, db);
  if (outcome.kind === "applied") return { ok: true };
  // `reasserted` is unreachable with from: ["queued"]; any other outcome is
  // a lost CAS — a concurrent terminal/authority change won.
  return { ok: false, reason: `root promotion CAS lost (observed ${outcome.observed ?? "missing"})` };
}

/**
 * First-dispatch execution start shared by both worker ports. The retained
 * executor claim fence only claims under executing/repairing supervision;
 * the runner owns this transition post-cutover. Only `awaiting_contract`
 * transitions (a rejected CAS is reported); re-entry under `executing` /
 * `repairing` is ok without resetting supervision or bumping its
 * generation; every other state is not dispatchable. The authority always
 * uses the supervision generation read in-call.
 */
function markExecutingForDispatch(
  reviewStore: ProjectReviewStore,
  run: { rootCardId: number; scheduledRunId?: string | null },
): { ok: true } | { ok: false; reason: string } {
  const sup = reviewStore.getSupervision(run.rootCardId);
  if (!sup) return { ok: false, reason: `supervision missing for card ${run.rootCardId}` };
  if (sup.state === "executing" || sup.state === "repairing") return { ok: true };
  if (sup.state !== "awaiting_contract") {
    return { ok: false, reason: `supervision not dispatchable (state ${sup.state})` };
  }
  const transitioned = reviewStore.stateTransition(run.rootCardId, ["awaiting_contract"], "executing", undefined, {
    authority: {
      projectCardId: run.rootCardId,
      projectGeneration: sup.generation,
      scheduledRunId: run.scheduledRunId ?? undefined,
    },
  });
  if (!transitioned) {
    return { ok: false, reason: `supervision execution transition rejected for card ${run.rootCardId}` };
  }
  return { ok: true };
}

export class WorkflowWorkerPort implements ExecutionPort {  readonly name = "workflow-worker";
  private readonly runner: WorkflowRunner;
  private readonly workers: WorkerSupervisionService;
  private readonly reviewStore: ProjectReviewStore;
  private readonly wakePump: () => void;

  constructor(deps: { runner: WorkflowRunner; wakePump?: () => void }) {
    this.runner = deps.runner;
    // #1799: the runner's own connection is the sole database — never the
    // module-global one, which may differ (or be unavailable) under test.
    this.workers = new WorkerSupervisionService(deps.runner.store.db);
    this.reviewStore = new ProjectReviewStore(deps.runner.store.db);
    this.wakePump = deps.wakePump ?? (() => {});
  }

  dispatch(cmd: CommandRow): void {
    const store = this.runner.store;
    const run = store.getRun(cmd.runId);
    if (!run) throw new WorkflowDispatchError(cmd.nodeId, `run ${cmd.runId} missing`);
    const payload = JSON.parse(cmd.payloadJson) as { nodeId: string; revision: number };
    const revision = Number(payload.revision);
    const spec = this.runner.planNodeSpec(cmd.runId, revision, cmd.nodeId);
    if (!spec) throw new WorkflowDispatchError(cmd.nodeId, "node missing from its plan revision");
    // Authority anchor: supervised settlement rejects work without a live
    // supervision row, so the port ensures one before creating the child.
    // Post-cutover this is the only writer of these rows for runner roots.
    this.reviewStore.ensureAwaitingContract(run.rootCardId);
    const sup = this.reviewStore.getSupervision(run.rootCardId);
    if (!sup || sup.state === "accepted" || sup.state === "blocked") {
      throw new WorkflowDispatchError(cmd.nodeId, `supervision not dispatchable (state ${sup?.state ?? "missing"})`);
    }
    // First dispatch starts execution: the retained executor claim fence
    // (claimAttemptWithinLimits) only claims under executing/repairing
    // supervision, and the runner owns this transition post-cutover
    // (pre-cutover define_project_contract initialized executing). Awaiting
    // stays until a worker actually dispatches; terminal projections accept
    // from either state.
    const transition = markExecutingForDispatch(this.reviewStore, run);
    if (!transition.ok) throw new WorkflowDispatchError(cmd.nodeId, transition.reason);
    // #1799: project the runner-owned root to running BEFORE the child's
    // card:queued event publishes, so the dispatch pump (which skips
    // children of non-running roots) sees an already-running root. A
    // dispatch that cannot establish a running, authorized root creates no
    // child.
    const projected = projectRunnerRootRunning(this.runner.store.db, run);
    if (!projected.ok) throw new WorkflowDispatchError(cmd.nodeId, `root not dispatchable: ${projected.reason}`);
    // Evidence path (worker-contract #1588 gate): every criterion needs a
    // required artifact or verification command. Declared node outputs become
    // REQUIRED artifacts, each linked to all of the node's criteria (coarse
    // linkage until proposals carry an explicit output→criterion map): the
    // worker must produce what the plan promised; settlement evidence
    // evaluation (unchanged existing behavior) verifies them, and review
    // judges their quality.
    const criteria = (spec.acceptance ?? []).map((a, i) => ({ id: `${cmd.nodeId}-c${i}`, description: a }));
    const criterionIds = criteria.map((c) => c.id);
    const artifacts = (spec.outputs ?? []).map((o, i) => ({
      id: `${cmd.nodeId}-o${i}`,
      kind: (o.includes("/") || o.includes(".")) ? ("file" as const) : ("logical" as const),
      ref: o, required: true as const, criterion_ids: [...criterionIds],
    }));
    const created = this.workers.createChild(
      spec.instructions, run.rootCardId, "workflow-runner",
      {
        criteria,
        expectedArtifacts: artifacts,
        requiredCapabilities: spec.capability ? [spec.capability] : [],
        supportsRootCriteria: [],
        authority: {
          projectCardId: run.rootCardId,
          projectGeneration: sup.generation,
          scheduledRunId: run.scheduledRunId ?? undefined,
        },
      },
    );
    if ("error" in created) {
      throw new WorkflowDispatchError(cmd.nodeId, boundText(created.error, 500));
    }
    store.bindNodeWorker(cmd.runId, revision, cmd.nodeId, created.cardId, created.attemptId);
    this.wakePump();
  }
}

/**
 * Whether a plan capability names Pi execution (minimal explicit routing).
 *
 * The plan schema carries no workspace-alias field, so Pi-ness travels in
 * spec.capability: a generic Pi capability (pi-coding/pi/pi-*) or a
 * capability that is itself a configured Pi workspace alias routes to the Pi
 * port; everything else (including "general" and Spin synonyms) stays Spin.
 * "spin" contains the substring "pi" — never use substring matching here.
 */
export function isPiCapability(capability: string | undefined | null): boolean {
  if (!capability || capability.length === 0) return false;
  if (capability === "pi-coding" || capability === "pi") return true;
  if (capability.startsWith("pi-")) return true;
  // A capability that names a configured Pi workspace alias is Pi work
  // with its workspace carried in the capability (plan schema has no alias
  // field). Configuration absence fails closed to Spin — never route to Pi
  // without a resolvable workspace. The try/catch keeps routing total when
  // Pi config is unreadable.
  try {
    const config = loadPiConfig();
    if (config && capability in config.workspaceAliases) return true;
  } catch {
    // Unreadable config: not Pi by alias (generic Pi names above still apply,
    // and dispatch will fail closed if no workspace resolves).
  }
  return false;
}

/**
 * Resolve the Pi workspace alias for a Pi-routed node spec.
 *
 * A Pi capability that is itself a configured alias carries the workspace
 * directly; a generic Pi capability (pi-coding/pi) resolves to the first
 * configured alias. Returns undefined when no workspace resolves — the
 * caller fails closed (never silently falls back to Spin; the reconciler
 * pump settles the coding child as pi_executor_unavailable).
 */
export function resolvePiWorkspaceAlias(capability: string | undefined | null): string | undefined {
  try {
    const config = loadPiConfig();
    if (!config) return undefined;
    const aliases = Object.keys(config.workspaceAliases);
    if (aliases.length === 0) return undefined;
    if (capability && capability in config.workspaceAliases) return capability;
    if (isPiCapability(capability)) return aliases[0];
    return undefined;
  } catch {
    return undefined;
  }
}

/** Runner capabilities for production admission (general + Pi).
 *
 * #1804: this is the compatibility set — it still admits already-stored
 * alias plans and explicit programmatic alias contracts through dispatch
 * and retries. Model-generated proposals use the narrower planner
 * vocabulary below, never this list.
 */
export function workflowCapabilities(): string[] {
  const caps = new Set<string>(["general", "pi-coding", "pi"]);
  try {
    const config = loadPiConfig();
    if (config) {
      for (const alias of Object.keys(config.workspaceAliases)) caps.add(alias);
    }
  } catch {
    // Config unreadable: generic Pi names still route (dispatch fails closed).
  }
  return [...caps];
}

/**
 * #1804 — model-facing planner vocabulary. Newly generated initial and
 * revised plans are offered exactly these capabilities with the execution
 * semantics stated in the planner prompt. Bare workspace aliases (for
 * example a configured `default`) are never offered here; a model proposal
 * naming one enters the bounded correction/revision path via
 * `validatePlannerProposal`, never a silent rewrite to general.
 */
export const PLANNER_CAPABILITIES: readonly string[] = ["general", "pi-coding", "pi"];

/** #1804 — planner-vocabulary view for the model prompt (copy, never the live set). */
export function plannerCapabilities(): string[] {
  return [...PLANNER_CAPABILITIES];
}

/** #1804 — whether a capability belongs to the model-facing vocabulary. */
export function isPlannerCapability(capability: string | undefined | null): boolean {
  if (!capability) return false;
  return (PLANNER_CAPABILITIES as readonly string[]).includes(capability);
}

/**
 * #1804 — planner-side admission for model-generated proposals. Rejects any
 * capability outside the planner vocabulary (bare workspace aliases,
 * pi-* variants, and unknown names) as a plan diagnostic so the existing
 * bounded correction/revision logic handles it. Runner-side
 * `validatePlanForRun` stays compatibility-wide for stored alias plans and
 * explicit programmatic contracts.
 */
export function validatePlannerProposal(proposal: PlanProposal): PlanDiagnostic[] {
  const problems: PlanDiagnostic[] = [];
  for (let i = 0; i < (proposal.nodes ?? []).length; i++) {
    const n = (proposal.nodes as Array<{ capability?: unknown }>)[i];
    const capability = typeof n?.capability === "string" ? (n.capability as string) : undefined;
    if (!isPlannerCapability(capability)) {
      problems.push({
        field: `nodes[${i}].capability`,
        reason: `unsupported planner capability ${String(capability ?? "(missing)")} (use one of: ${PLANNER_CAPABILITIES.join(", ")})`,
      });
    }
  }
  return problems;
}

export interface PiPortDeps {
  runner: WorkflowRunner;
  wakePump?: () => void;
  /** Test seam: resolve the workspace alias for a node spec (default: capability-derived). */
  workspaceAliasFor?: (spec: { capability?: string }) => string | undefined;
}

/**
 * Pi execution port (#1792 Task 5, #1638): mirrors WorkflowWorkerPort's
 * creation/binding sequence (criteria/expected-artifacts from the plan spec
 * via WorkerSupervisionService.createChild with the runner authority) with a
 * workspace alias so the contract-derived intent resolver picks pi/pi-coding.
 * The existing PiExecutorAdapter boundary (via the reconciler dispatch pump)
 * starts the attempt, binds the Pi run resource (bindExecutorResource), and
 * settles through SupervisedPiSettlement — the port only creates, binds the
 * node worker (worker_card_id linkage for the joint commit's findNodeByCard),
 * and wakes the pump. Never falls back to Spin: an unresolvable workspace
 * throws a visible WorkflowDispatchError (the pump settles coding children
 * without a live Pi service as pi_executor_unavailable).
 */
export class WorkflowPiPort implements ExecutionPort {
  readonly name = "workflow-pi-worker";
  private readonly runner: WorkflowRunner;
  private readonly workers: WorkerSupervisionService;
  private readonly reviewStore: ProjectReviewStore;
  private readonly wakePump: () => void;
  private readonly workspaceAliasFor?: (spec: { capability?: string }) => string | undefined;

  constructor(deps: PiPortDeps) {
    this.runner = deps.runner;
    // #1799: the runner's own connection is the sole database (see Spin port).
    this.workers = new WorkerSupervisionService(deps.runner.store.db);
    this.reviewStore = new ProjectReviewStore(deps.runner.store.db);
    this.wakePump = deps.wakePump ?? (() => {});
    this.workspaceAliasFor = deps.workspaceAliasFor;
  }

  dispatch(cmd: CommandRow): void {
    const store = this.runner.store;
    const run = store.getRun(cmd.runId);
    if (!run) throw new WorkflowDispatchError(cmd.nodeId, `run ${cmd.runId} missing`);
    const payload = JSON.parse(cmd.payloadJson) as { nodeId: string; revision: number };
    const revision = Number(payload.revision);
    const spec = this.runner.planNodeSpec(cmd.runId, revision, cmd.nodeId);
    if (!spec) throw new WorkflowDispatchError(cmd.nodeId, "node missing from its plan revision");
    this.reviewStore.ensureAwaitingContract(run.rootCardId);
    const sup = this.reviewStore.getSupervision(run.rootCardId);
    if (!sup || sup.state === "accepted" || sup.state === "blocked") {
      throw new WorkflowDispatchError(cmd.nodeId, `supervision not dispatchable (state ${sup?.state ?? "missing"})`);
    }
    const transition = markExecutingForDispatch(this.reviewStore, run);
    if (!transition.ok) throw new WorkflowDispatchError(cmd.nodeId, transition.reason);
    // #1799: same root projection as the Spin port — before child creation.
    const projected = projectRunnerRootRunning(this.runner.store.db, run);
    if (!projected.ok) throw new WorkflowDispatchError(cmd.nodeId, `root not dispatchable: ${projected.reason}`);
    const workspaceAlias = this.workspaceAliasFor
      ? this.workspaceAliasFor(spec)
      : resolvePiWorkspaceAlias(spec.capability);
    if (!workspaceAlias) {
      throw new WorkflowDispatchError(cmd.nodeId, `pi workspace unresolvable for capability ${spec.capability ?? "(none)"}`);
    }
    const criteria = (spec.acceptance ?? []).map((a, i) => ({ id: `${cmd.nodeId}-c${i}`, description: a }));
    const criterionIds = criteria.map((c) => c.id);
    const artifacts = (spec.outputs ?? []).map((o, i) => ({
      id: `${cmd.nodeId}-o${i}`,
      kind: (o.includes("/") || o.includes(".")) ? ("file" as const) : ("logical" as const),
      ref: o, required: true as const, criterion_ids: [...criterionIds],
    }));
    const created = this.workers.createChild(
      spec.instructions, run.rootCardId, "workflow-runner",
      {
        criteria,
        expectedArtifacts: artifacts,
        requiredCapabilities: spec.capability ? [spec.capability] : [],
        supportsRootCriteria: [],
        workspaceAlias,
        authority: {
          projectCardId: run.rootCardId,
          projectGeneration: sup.generation,
          scheduledRunId: run.scheduledRunId ?? undefined,
        },
      },
    );
    if ("error" in created) {
      throw new WorkflowDispatchError(cmd.nodeId, boundText(created.error, 500));
    }
    // Same worker_card_id linkage the Spin port writes: the settlement joint
    // commit's findNodeByCard reads worker_card_id to resolve the node.
    store.bindNodeWorker(cmd.runId, revision, cmd.nodeId, created.cardId, created.attemptId);
    this.wakePump();
  }
}

/**
 * Capability-routed executor (Spin default, Pi when the node spec names Pi).
 * Reads the node spec for the dispatched command and delegates to the Pi or
 * Spin port. Minimal and explicit: isPiCapability decides, no
 * natural-language classification, no fallback reinterpretation.
 */
export class RoutingWorkflowWorkerPort implements ExecutionPort {
  readonly name = "workflow-worker-routing";
  private readonly runner: WorkflowRunner;
  private readonly spinPort: WorkflowWorkerPort;
  private readonly piPort: WorkflowPiPort;

  constructor(deps: { runner: WorkflowRunner; wakePump?: () => void; workspaceAliasFor?: (spec: { capability?: string }) => string | undefined }) {
    this.runner = deps.runner;
    this.spinPort = new WorkflowWorkerPort({ runner: deps.runner, wakePump: deps.wakePump });
    this.piPort = new WorkflowPiPort({ runner: deps.runner, wakePump: deps.wakePump, workspaceAliasFor: deps.workspaceAliasFor });
  }

  dispatch(cmd: CommandRow): void {
    let capability: string | undefined;
    try {
      const payload = JSON.parse(cmd.payloadJson) as { nodeId: string; revision: number };
      const spec = this.runner.planNodeSpec(cmd.runId, Number(payload.revision), cmd.nodeId);
      capability = spec?.capability;
    } catch {
      capability = undefined;
    }
    if (isPiCapability(capability)) {
      this.piPort.dispatch(cmd);
      return;
    }
    this.spinPort.dispatch(cmd);
  }
}

export class SpinPlannerBackend implements PlannerBackend {
  readonly name = "spin-planner";
  private readonly runner: WorkflowRunner;
  private readonly callModel: ModelCall;
  private readonly onSettled: () => void;

  constructor(deps: { runner: WorkflowRunner; callModel: ModelCall; onSettled?: () => void }) {
    this.runner = deps.runner;
    this.callModel = deps.callModel;
    this.onSettled = deps.onSettled ?? (() => {});
  }

  startPlanning(cmd: CommandRow, input: PlanningInput): void {
    void this.run(cmd, input).catch(() => {
      // Start/parse failures leave the claim for lease expiry + inspection
      // (bounded by MAX_CONSECUTIVE_INCONCLUSIVE, terminating explicitly).
      // Never throw past drain: one bad model turn must not wedge the queue.
    });
  }

  private async run(cmd: CommandRow, input: PlanningInput): Promise<void> {
    const store = this.runner.store;
    // #1795: the complete saved goal — never a silently shortened task.
    // Provider/context failures stay explicit errors downstream.
    const goal = this.goalOf(cmd.runId);
    // #1795: the immutable bound workspace, when one is bound. Unbound runs
    // keep the generic workspace-relative rule above (no concrete root to
    // state); a bound root is always stated explicitly, never assumed.
    const workspace = this.runner.boundWorkspaceOf(cmd.runId);
    // #1804: the model sees only the planner vocabulary, never the runner's
    // compatibility set (which still admits stored alias plans elsewhere).
    const caps = plannerCapabilities();
    let problems = "";
    let lastDiagnostics: PlanDiagnostic[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await this.callModel(planPrompt({
        goal, requiredOutputs: input.requiredOutputs, capabilities: caps,
        priorResults: input.defects.length > 0 ? JSON.stringify(input.defects) : "",
        attempt, problem: attempt === 0 ? undefined : problems,
        workspace,
      }), PLANNER_TIMEOUT_MS);
      let proposal: PlanProposal;
      try {
        proposal = parseProposal(text);
      } catch (err) {
        problems = err instanceof Error ? err.message : String(err);
        lastDiagnostics = [{ field: "proposal", reason: problems }];
        if (attempt === 0) continue;
        break;
      }
      // #1804: model proposals are gated on the planner vocabulary first, so
      // a bare alias (for example `default`) enters the bounded
      // correction/revision path here. Runner-side admission stays
      // compatibility-wide for stored alias plans and explicit contracts.
      // Never silently rewrite a rejected Pi/alias proposal to general.
      const plannerDiagnostics = validatePlannerProposal(proposal);
      const runnerDiagnostics = this.runner.validatePlanForRun(cmd.runId, proposal);
      const diagnostics = [...plannerDiagnostics, ...runnerDiagnostics];
      if (diagnostics.length > 0) {
        problems = diagnostics.map((p) => `${p.field}: ${p.reason}`).join("; ");
        lastDiagnostics = diagnostics;
        if (attempt === 0) continue;
        break;
      }
      const base = store.currentRevision(cmd.runId);
      this.runner.submitPlanProposal(cmd.runId, proposal, {
        baseRevision: input.purpose === "initial" ? undefined : base,
        opId: input.opId,
        completesNode: input.purpose === "next_wave"
          ? { revision: input.revision ?? base, nodeId: input.nodeId, outcome: "proposed" }
          : undefined,
        // Failed-round identity: a rejected proposal requeues this same
        // round (runner-side, bounded by plan_revision) instead of stranding
        // a claimed command the swallowed error below would abandon.
        planRound: { nodeId: cmd.nodeId, ordinal: cmd.ordinal, payloadJson: cmd.payloadJson },
      });
      // Complete our claim: the proposal is admitted.
      const key = { runId: cmd.runId, generation: cmd.generation, nodeId: cmd.nodeId, action: cmd.action, ordinal: cmd.ordinal };
      const live = store.getCommand(key);
      if (live && live.status === "claimed") {
        store.completeCommand(key, live.owner ?? this.name, live.claimToken ?? "");
      }
      // AstraMaster-3: the newly queued work (dispatch/review commands) needs
      // a drain. The driver only listens for card events, so without this
      // wake the run waits for the periodic audit.
      this.onSettled();
      return;
    }
    // #1795: both local attempts failed — hand the rejection to the runner
    // instead of throwing past drain. rejectPlanRound records PlanRejected,
    // consumes one plan_revision, and requeues this round (or fails the run
    // on exhaustion). This backend still throws: the claim must not complete
    // as success, and on exhaustion there is nothing to wake for.
    const { outcome, reason } = this.runner.rejectPlanRound(cmd.runId, lastDiagnostics, {
      opId: input.opId,
      planRound: { nodeId: cmd.nodeId, ordinal: cmd.ordinal, payloadJson: cmd.payloadJson },
    });
    if (outcome === "requeued") this.onSettled();
    throw new Error(`planner corrections exhausted: ${reason}`);
  }

  private goalOf(runId: string): string {
    const run = this.runner.store.getRun(runId);
    if (!run) return runId;
    const card = this.runner.store.db
      .prepare(`SELECT title, goal FROM kanban_board WHERE id = ?`)
      .get(run.rootCardId) as { title: string; goal: string | null } | undefined;
    // #1795: complete saved goal — no silent truncation. All planning rounds
    // receive the full task, including rules captured beyond any cutoff.
    return card?.goal ?? card?.title ?? runId;
  }
}

export class SpinReviewerBackend implements ReviewBackend {
  readonly name = "spin-reviewer";
  private readonly runner: WorkflowRunner;
  private readonly callModel: ModelCall;
  private readonly onSettled: () => void;

  constructor(deps: { runner: WorkflowRunner; callModel: ModelCall; onSettled?: () => void }) {
    this.runner = deps.runner;
    this.callModel = deps.callModel;
    this.onSettled = deps.onSettled ?? (() => {});
  }

  startReview(cmd: CommandRow, brief: ReviewBrief): void {
    void this.run(cmd, brief).catch(() => {
      // Verdict never arrived: the claim stays for lease expiry + inspection,
      // which fails the review explicitly at the bound. Never throw past drain.
    });
  }

  private async run(cmd: CommandRow, brief: ReviewBrief): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await this.callModel(reviewPrompt(brief), REVIEWER_TIMEOUT_MS);
      let verdict: ReviewVerdict;
      try {
        verdict = parseVerdict(text);
      } catch (err) {
        if (attempt === 0) continue;
        throw err;
      }
      // Runner validates criterion linkage + budgets; malformed verdicts take
      // the bounded protocol-correction path (never a fresh execution turn).
      this.runner.submitVerdict(cmd.runId, cmd.nodeId, verdict);
      const key = { runId: cmd.runId, generation: cmd.generation, nodeId: cmd.nodeId, action: cmd.action, ordinal: cmd.ordinal };
      const live = this.runner.store.getCommand(key);
      if (live && live.status === "claimed") {
        this.runner.store.completeCommand(key, live.owner ?? this.name, live.claimToken ?? "");
      }
      // AstraMaster-3: an accept queues delivery, changes_required queues
      // repair planning — both need a drain wake, not just the audit.
      this.onSettled();
      return;
    }
  }
}

/**
 * Production delivery sender (AstraMaster-2): hands the accepted output to
 * the operator-visible pipeline. The drain supports a sender, but the
 * driver never provided one — deliver commands fell into the worker
 * executor, which threw (a review node is in no plan revision), leaving the
 * obligation pending and the hasPendingDelivery gate wedging the run.
 *
 * The send posts the accepted-output manifest to the root card's channel
 * with the idempotence key as the once-only source ref: retries collapse to
 * "duplicate" (still acknowledged), and the durable receipt carries the
 * manifest for the terminal projections, which write result_summary /
 * result_path onto the card for kanban-delivery + scheduled settlement.
 */
export class ChannelDeliverySender implements DeliverySender {
  readonly name = "channel-delivery";
  private readonly runner: WorkflowRunner;

  constructor(deps: { runner: WorkflowRunner }) {
    this.runner = deps.runner;
  }

  send(doc: { runId: string; nodeId: string; obligation: string; idempotenceKey: string }): string {
    const run = this.runner.store.getRun(doc.runId);
    if (!run) throw new Error(`channel delivery: run ${doc.runId} missing`);
    let revision = this.runner.store.currentRevision(doc.runId);
    try {
      const parsed = JSON.parse(doc.obligation) as { revision?: unknown };
      if (typeof parsed.revision === "number") revision = parsed.revision;
    } catch {
      // Unparseable obligation: manifest the current revision instead.
    }
    const produced: string[] = [];
    for (const n of this.runner.store.listNodes(doc.runId, revision)) {
      if (n["status"] !== "succeeded" || typeof n["outcome"] !== "string") continue;
      const match = (n["outcome"] as string).match(/"artifact"\s*:\s*"([^"]+)"/)
        ?? (n["outcome"] as string).match(/"result_path"\s*:\s*"([^"]+)"/)
        ?? (n["outcome"] as string).match(/"path"\s*:\s*"([^"]+)"/);
      produced.push(`${n["node_id"] as string}:${match?.[1] ?? "ok"}`);
    }
    const manifest = [
      `Workflow run ${doc.runId} revision ${revision} accepted (review ${doc.nodeId}).`,
      `Produced: ${produced.length > 0 ? produced.join(", ") : "none recorded"}.`,
    ].join(" ");
    const posted = channelPostOnce({
      cardId: run.rootCardId, from: "workflow-runner", to: "ALL",
      message: manifest, msgType: "delivery",
      sourceRef: `wf-delivery:${doc.idempotenceKey}`,
    });
    if (posted === "unavailable") throw new Error("channel delivery: store unavailable");
    return JSON.stringify({ posted, cardId: run.rootCardId, idempotenceKey: doc.idempotenceKey, manifest });
  }
}
