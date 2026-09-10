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
import { ProjectReviewStore } from "../project-acceptance/project-review-store.js";
import { WorkerSupervisionService } from "../worker-supervision-service.js";
import { loadPiConfig } from "../pi-executor/config.js";
import {
  WorkflowRunner,
  boundText,
  type ExecutionPort,
  type PlanProposal,
  type PlannerBackend,
  type PlanningInput,
  type ReviewBackend,
  type ReviewBrief,
  type ReviewVerdict,
} from "./orc-workflow-runner.js";
import type { CommandRow } from "./orc-workflow-store.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

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
}): string {
  return [
    "You are a work planner. Decompose the goal into a parallelizable work graph.",
    "Respond with NOTHING but a single JSON object (no markdown fences, no prose):",
    '{"nodes":[{"label":"short-id","kind":"work|synthesis","instructions":"...","capability":"...","outputs":["..."],"acceptance":["..."],"dependsOn":["..."],"optional":false}],"requiredOutputs":["..."],"allowPartial":false}',
    "Rules: every work/synthesis node needs non-empty instructions, capability (one of: "
      + `${input.capabilities.join(", ")}), outputs, acceptance, and dependsOn (possibly empty).`,
    "Labels unique. Dependencies must reference declared labels. No cycles.",
    "Every requiredOutput must be declared in some node's outputs.",
    "All outputs must be workspace-relative paths (e.g. out/report.md) — never absolute paths, never ~, never /home or /tmp prefixes. Absolute outputs are rejected.",
    "Include an explicit synthesis node when the requested output needs assembled writing.",
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
    `Required outputs: ${brief.requiredOutputs.join(", ")}`,
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
 * First-dispatch execution start shared by both worker ports. The retained
 * executor claim fence only claims under executing/repairing supervision;
 * the runner owns this transition post-cutover. Idempotent: a second call
 * with any non-awaiting state is a no-op (stateTransition CAS misses).
 */
function markExecutingForDispatch(
  reviewStore: ProjectReviewStore,
  run: { rootCardId: number; scheduledRunId?: string | null },
  generation?: number,
): void {
  const sup = reviewStore.getSupervision(run.rootCardId);
  if (!sup || sup.state !== "awaiting_contract") return;
  reviewStore.stateTransition(run.rootCardId, ["awaiting_contract"], "executing", undefined, {
    authority: {
      projectCardId: run.rootCardId,
      projectGeneration: generation ?? sup.generation,
      scheduledRunId: run.scheduledRunId ?? undefined,
    },
  });
}

export class WorkflowWorkerPort implements ExecutionPort {  readonly name = "workflow-worker";
  private readonly runner: WorkflowRunner;
  private readonly workers: WorkerSupervisionService;
  private readonly reviewStore: ProjectReviewStore;
  private readonly wakePump: () => void;

  constructor(deps: { runner: WorkflowRunner; db?: TaskDatabase; wakePump?: () => void }) {
    this.runner = deps.runner;
    this.workers = new WorkerSupervisionService(deps.db);
    this.reviewStore = new ProjectReviewStore(deps.db);
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
    markExecutingForDispatch(this.reviewStore, run);
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

/** Runner capabilities for production admission (general + Pi). */
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

export interface PiPortDeps {
  runner: WorkflowRunner;
  db?: TaskDatabase;
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
    this.workers = new WorkerSupervisionService(deps.db);
    this.reviewStore = new ProjectReviewStore(deps.db);
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
    markExecutingForDispatch(this.reviewStore, run, sup.generation);
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

  constructor(deps: { runner: WorkflowRunner; db?: TaskDatabase; wakePump?: () => void; workspaceAliasFor?: (spec: { capability?: string }) => string | undefined }) {
    this.runner = deps.runner;
    this.spinPort = new WorkflowWorkerPort({ runner: deps.runner, db: deps.db, wakePump: deps.wakePump });
    this.piPort = new WorkflowPiPort({ runner: deps.runner, db: deps.db, wakePump: deps.wakePump, workspaceAliasFor: deps.workspaceAliasFor });
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

  constructor(deps: { runner: WorkflowRunner; callModel: ModelCall }) {
    this.runner = deps.runner;
    this.callModel = deps.callModel;
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
    const goal = this.goalOf(cmd.runId);
    const caps = [...this.runner.capabilities];
    let problems = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await this.callModel(planPrompt({
        goal, requiredOutputs: input.requiredOutputs, capabilities: caps,
        priorResults: input.defects.length > 0 ? JSON.stringify(input.defects) : "",
        attempt, problem: attempt === 0 ? undefined : problems,
      }), PLANNER_TIMEOUT_MS);
      let proposal: PlanProposal;
      try {
        proposal = parseProposal(text);
      } catch (err) {
        problems = err instanceof Error ? err.message : String(err);
        if (attempt === 0) continue;
        throw err;
      }
      const found = this.runner.validatePlan(proposal);
      if (found.length > 0) {
        problems = found.map((p) => `${p.field}: ${p.reason}`).join("; ");
        if (attempt === 0) continue;
        throw new Error(`proposal invalid: ${problems}`);
      }
      const base = store.currentRevision(cmd.runId);
      this.runner.submitPlanProposal(cmd.runId, proposal, {
        baseRevision: input.purpose === "initial" ? undefined : base,
        opId: input.opId,
        completesNode: input.purpose === "next_wave"
          ? { revision: input.revision ?? base, nodeId: input.nodeId, outcome: "proposed" }
          : undefined,
      });
      // Complete our claim: the proposal is admitted.
      const key = { runId: cmd.runId, generation: cmd.generation, nodeId: cmd.nodeId, action: cmd.action, ordinal: cmd.ordinal };
      const live = store.getCommand(key);
      if (live && live.status === "claimed") {
        store.completeCommand(key, live.owner ?? this.name, live.claimToken ?? "");
      }
      return;
    }
  }

  private goalOf(runId: string): string {
    const run = this.runner.store.getRun(runId);
    if (!run) return runId;
    const card = this.runner.store.db
      .prepare(`SELECT title, goal FROM kanban_board WHERE id = ?`)
      .get(run.rootCardId) as { title: string; goal: string | null } | undefined;
    return (card?.goal ?? card?.title ?? runId).slice(0, 2000);
  }
}

export class SpinReviewerBackend implements ReviewBackend {
  readonly name = "spin-reviewer";
  private readonly runner: WorkflowRunner;
  private readonly callModel: ModelCall;

  constructor(deps: { runner: WorkflowRunner; callModel: ModelCall }) {
    this.runner = deps.runner;
    this.callModel = deps.callModel;
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
      return;
    }
  }
}
