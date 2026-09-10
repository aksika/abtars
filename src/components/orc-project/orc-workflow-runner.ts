/**
 * orc-workflow-runner.ts — #1792 Task 2: the sole supervised transition
 * implementation (core: admission, plan validation/admission, node dispatch
 * state, worker completion/failure with bounded retry, terminal outcome,
 * durable next commands, startup recovery, audit classification).
 *
 * Task 3 adds planning/review jobs; Task 4 adds failure remediation, input,
 * delivery execution, and ClaimExpired inspection; Task 5 cuts over entry
 * points and wires the heartbeat. This module never writes legacy phase
 * tables (project_supervision/kanban/task_runs) — those projections are wired
 * in Task 5 to avoid a dual controller during construction.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  WorkflowStore,
  COMMAND_CLAIM_LEASE_MIN,
  MAX_CONSECUTIVE_INCONCLUSIVE,
  type BudgetScope,
  type CommandAction,
  type CommandKey,
  type CommandRow,
  type CommitResult,
  type NodeKind,
  type ResolvedBudgets,
  type RootKind,
  type RunnerIngress,
  type TransitionEffect,
  type WorkflowRunRow,
  type WorkflowRunState,
} from "./orc-workflow-store.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

// ── proposal types (native structured values; transport serializes) ────

export interface PlanNodeProposal {
  label: string;
  kind: NodeKind;
  instructions: string;
  capability: string;
  outputs: string[];
  acceptance: string[];
  dependsOn: string[];
  optional?: boolean;
}

export interface PlanProposal {
  nodes: PlanNodeProposal[];
  requiredOutputs: string[];
  allowPartial?: boolean;
}

export interface PlanDiagnostic {
  field: string;
  reason: string;
}

export interface AcceptedPlan {
  revision: number;
  nodeIds: string[];
  queued: number;
}

// ── execution port (stable attempt identities cross the boundary here) ──

export interface ExecutionPort {
  name: string;
  dispatch(cmd: CommandRow): void;
  reconcileLiveAttempts?(runId: string): void;
}

// ── model-job backends (Task 3; transport wiring lands in Task 5) ──────
// Planner/reviewer MODEL invocations are ordinary bounded jobs: the host owns
// identities, budgets, authority, and result application; the model supplies
// only the proposal/plan text or the quality verdict. Backends kick off async
// work and complete later via submitPlanProposal/submitVerdict ingress.

export interface ReviewBrief {
  runId: string;
  revision: number;
  nodeId: string;
  request: { title: string; goal: string | null };
  requiredOutputs: string[];
  criteriaByNode: Record<string, string[]>;
  nodes: Array<{ nodeId: string; kind: string; status: string; outcome: string | null; attemptId: string | null }>;
  failures: Array<{ nodeId: string; outcome: string | null }>;
  evidenceIds: string[];
  budgets: Record<string, { allowed: number; consumed: number }>;
}

export type ReviewVerdict =
  | { verdict: "accept" }
  | { verdict: "changes_required"; defects: Array<{ criterion: string; detail: string }> }
  | { verdict: "cannot_assess"; reason: string };

export interface ReviewBackend {
  name: string;
  startReview(cmd: CommandRow, brief: ReviewBrief): void;
}

export interface PlanningInput {
  runId: string;
  revision: number | null;
  purpose: "initial" | "repair" | "next_wave";
  defects: Array<{ criterion: string; detail: string }>;
  requiredOutputs: string[];
}

export interface PlannerBackend {
  name: string;
  startPlanning(cmd: CommandRow, input: PlanningInput): void;
}

export type DrainPorts =
  | ExecutionPort
  | { executor: ExecutionPort; reviewer: ReviewBackend; planner: PlannerBackend };

export type VerdictOutcome = "accepted" | "repair_queued" | "failed" | "unassessable" | "correction_queued";

export const DELIVERY_MAX_ATTEMPTS = 3;

export interface DrainOpts {
  policy?: ResourcePolicy;
}

/** Bounded, sanitized diagnostics: never log raw tool payloads (req 12). */
export function boundText(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : JSON.stringify(value) ?? "unserializable";
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
}

/** Thrown by ExecutionPorts at capacity: drain releases the claim and continues. */
export class CapacityBusy extends Error {
  constructor(message = "executor at capacity") {
    super(message);
    this.name = "CapacityBusy";
  }
}

/** Parse a DB timestamp as UTC millis; SQLite 'YYYY-MM-DD HH:MM:SS' has no
 * designator, so tag it explicitly rather than inheriting local TZ. NaN when
 * unparseable (callers treat unparseable as stale — safe direction). */
function dbTimeMillis(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return Date.parse(iso);
}

/** Lease heartbeat fresh iff its next evaluation lies in the future. */
function leaseFresh(snapshot: Record<string, unknown> | null): boolean {
  if (!snapshot || snapshot["closed_at"] != null) return false;
  const t = dbTimeMillis(snapshot["next_evaluation_at"]);
  return !Number.isNaN(t) && t > Date.now();
}

/**
 * Resource policy consulted before dispatch claims. Scoping lives here:
 * an execution fuse refuses dispatch actions, never review work or
 * already-completed evidence.
 */
export interface ResourcePolicy {
  check(input: { runId: string; action: string; resource?: string }): "ok" | "refused";
}

export interface DrainOpts {
  policy?: ResourcePolicy;
}

function isJobPorts(ports: DrainPorts): ports is { executor: ExecutionPort; reviewer: ReviewBackend; planner: PlannerBackend } {
  return (ports as { executor?: ExecutionPort }).executor !== undefined;
}

/** Stable op identity: one planning/review job per (run, revision, node). */
function opIdFor(runId: string, revision: number, nodeId: string): string {
  return `op-${runId}-r${revision}-${nodeId}`;
}

// ── runner ───────────────────────────────────────────────────────────────

const TERMINAL_RUN_STATES: WorkflowRunState[] = ["succeeded", "failed", "cancelled"];

export class WorkflowRunner {
  readonly store: WorkflowStore;
  /** Capabilities the host supports (planner proposals are validated against these). */
  readonly capabilities: ReadonlySet<string>;

  constructor(store: WorkflowStore, capabilities?: Iterable<string>) {
    this.store = store;
    this.capabilities = new Set(capabilities ?? ["general"]);
  }

  static withDatabase(db: TaskDatabase, capabilities?: Iterable<string>): WorkflowRunner {
    return new WorkflowRunner(new WorkflowStore(db), capabilities);
  }

  // ── admission ─────────────────────────────────────────────────────────

  admit(input: {
    rootKind: RootKind;
    rootCardId: number;
    scheduledRunId?: string | null;
    clientOperationId: string;
    budgets?: Partial<Record<BudgetScope, number>>;
  }): { run: WorkflowRunRow; disposition: "admitted" | "duplicate" } {
    const budgets: ResolvedBudgets = {
      work_retry: input.budgets?.work_retry ?? 1,
      plan_revision: input.budgets?.plan_revision ?? 2,
      review_repair: input.budgets?.review_repair ?? 2,
      protocol_correction: input.budgets?.protocol_correction ?? 1,
    };
    const admitted = this.store.admitRun({ ...input, budgets });
    return { run: admitted.row, disposition: admitted.disposition };
  }

  // ── plan validation + admission ───────────────────────────────────────

  validatePlan(proposal: PlanProposal, priorOutputs: string[] = []): PlanDiagnostic[] {
    const problems: PlanDiagnostic[] = [];
    if (!proposal || !Array.isArray(proposal.nodes) || proposal.nodes.length === 0) {
      problems.push({ field: "nodes", reason: "plan must declare at least one node" });
      return problems;
    }
    const seen = new Set<string>();
    proposal.nodes.forEach((n, i) => {
      if (!n || typeof n.label !== "string" || n.label.length === 0) {
        problems.push({ field: `nodes[${i}].label`, reason: "label required" });
        return;
      }
      if (seen.has(n.label)) problems.push({ field: `nodes[${i}].label`, reason: `duplicate label ${n.label}` });
      seen.add(n.label);
      if (!["work", "synthesis", "planning", "review", "delivery"].includes(n.kind)) {
        problems.push({ field: `nodes[${i}].kind`, reason: `unsupported kind ${String(n.kind)}` });
      }
      if (typeof n.instructions !== "string" || n.instructions.length === 0) {
        problems.push({ field: `nodes[${i}].instructions`, reason: "instructions required" });
      }
      if (!this.capabilities.has(n.capability)) {
        problems.push({ field: `nodes[${i}].capability`, reason: `unsupported capability ${n.capability}` });
      }
      if (!Array.isArray(n.outputs)) problems.push({ field: `nodes[${i}].outputs`, reason: "outputs must be an array" });
      if (!Array.isArray(n.acceptance)) problems.push({ field: `nodes[${i}].acceptance`, reason: "acceptance must be an array" });
      if (!Array.isArray(n.dependsOn)) problems.push({ field: `nodes[${i}].dependsOn`, reason: "dependsOn must be an array" });
    });
    proposal.nodes.forEach((n, i) => {
      if (!n || !Array.isArray(n.dependsOn)) return;
      for (const dep of n.dependsOn) {
        if (dep === n.label) problems.push({ field: `nodes[${i}].dependsOn`, reason: "node cannot depend on itself" });
        else if (!seen.has(dep)) problems.push({ field: `nodes[${i}].dependsOn`, reason: `unknown node ${dep}` });
      }
    });
    // Acyclicity (iterative DFS over labels).
    const edges = new Map<string, string[]>();
    for (const n of proposal.nodes) {
      if (!n) continue;
      edges.set(n.label, ((n.dependsOn ?? []) as string[]).filter((d) => seen.has(d)));
    }
    const color = new Map<string, number>();
    const visit = (label: string, stack: string[]): boolean => {
      color.set(label, 1);
      for (const dep of edges.get(label) ?? []) {
        const c = color.get(dep) ?? 0;
        if (c === 1) {
          problems.push({ field: "nodes", reason: `dependency cycle: ${[...stack, label, dep].join(" -> ")}` });
          return false;
        }
        if (c === 0 && !visit(dep, [...stack, label])) return false;
      }
      color.set(label, 2);
      return true;
    };
    for (const n of proposal.nodes) {
      if (!n) continue;
      if ((color.get(n.label) ?? 0) === 0) visit(n.label, []);
    }
    // Required-output coverage: the revision's own nodes plus the cumulative
    // outputs of prior revisions (a repair/next-wave revision builds on work
    // already produced; it must not re-produce it to count it).
    const provided = new Set<string>(priorOutputs);
    for (const n of proposal.nodes) {
      if (!n || !Array.isArray(n.outputs)) continue;
      for (const o of n.outputs) provided.add(o);
    }
    for (const req of proposal.requiredOutputs ?? []) {
      if (!provided.has(req)) problems.push({ field: "requiredOutputs", reason: `no node declares output ${req}` });
    }
    return problems;
  }

  acceptPlan(runId: string, proposal: PlanProposal): AcceptedPlan {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`workflow runner: run ${runId} missing`);
    if (TERMINAL_RUN_STATES.includes(run.state)) {
      throw new Error(`workflow runner: run ${runId} already terminal`);
    }
    // Initial admission only: revisions append through submitPlanProposal,
    // which cancels superseded work and enforces acceptance monotonicity.
    if (this.store.currentRevision(runId) !== 0) {
      throw new Error(`workflow runner: run ${runId} already has a plan; use submitPlanProposal`);
    }
    const problems = this.validatePlan(proposal);
    if (problems.length > 0) {
      // Invalid proposal: no worker side effects. Each rejection consumes the
      // plan_revision allowance; exhaustion fails the run with the diagnostics.
      const text = boundText(problems.map((p) => `${p.field}: ${p.reason}`).join("; "), 2000);
      const res = this.commitKind(run, "PlanRejected", { problems }, () => {
        const ok = this.store.consumeBudget(runId, "plan_revision");
        if (!ok) {
          return { nextState: "failed" as const, failureCode: "plan_rejected", failureReason: text };
        }
        return { nextState: "planning" as const };
      });
      if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
      throw new Error(`workflow runner: plan rejected: ${text}`);
    }
    const revision = this.store.currentRevision(runId) + 1;
    const hostIds = proposal.nodes.map(
      (n, i) => `n${revision}_${i}_${n.label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24)}`,
    );
    const byLabel = new Map(proposal.nodes.map((n, j) => [n.label, hostIds[j] as string]));
    let queued = 0;
    const res = this.commitKind(run, "PlanAccepted", { revision }, () => {
      this.store.insertPlanRevision(runId, revision, JSON.stringify(proposal));
      this.store.insertNodes(
        proposal.nodes.map((n, i) => ({ runId, revision, nodeId: hostIds[i] as string, kind: n.kind })),
      );
      for (let i = 0; i < proposal.nodes.length; i++) {
        const n = proposal.nodes[i] as PlanNodeProposal;
        this.store.insertDeps(
          (n.dependsOn ?? []).map((dep) => ({
            runId, revision, nodeId: hostIds[i] as string, dependsOn: byLabel.get(dep) as string,
          })),
        );
      }
      const byId = new Map(proposal.nodes.map((n, i) => [hostIds[i] as string, n]));
      for (const row of this.store.listNodes(runId, revision)) {
        const nodeId = row["node_id"] as string;
        if (this.store.hasUnsatisfiedDeps(runId, revision, nodeId)) continue;
        this.queueForNode(runId, run.generation, revision, nodeId, byId.get(nodeId)?.kind ?? "work", {});
        queued++;
      }
      return { nextState: "dispatched" as const };
    });
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
    return { revision, nodeIds: hostIds, queued };
  }

  // ── worker completion (live path builds a fresh event; recovery replays
  // stored identity through the same appliers) ───────────────────────────

  attemptSucceeded(runId: string, nodeId: string, attemptId: string, artifactsJson: string): void {
    const run = this.requireLive(runId);
    const revision = this.store.currentRevision(runId);
    const res = this.applyAttemptSucceeded(run, revision, nodeId, attemptId, artifactsJson,
      this.freshEvent(run, "AttemptSucceeded", { nodeId, attemptId }));
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
  }

  attemptFailed(runId: string, nodeId: string, attemptId: string, cause: string, retrySafe: boolean): void {
    const run = this.requireLive(runId);
    const revision = this.store.currentRevision(runId);
    const boundedCause = boundText(cause, 2000);
    const res = this.applyAttemptFailed(run, revision, nodeId, attemptId, boundedCause, retrySafe,
      this.freshEvent(run, "AttemptFailed", { nodeId, attemptId, cause: boundedCause }));
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
  }

  // ── review briefs (Task 3: prepared, immutable, host-assembled) ────

  assembleBrief(runId: string, revision: number, nodeId: string): ReviewBrief {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`workflow runner: run ${runId} missing`);
    const card = this.store.db
      .prepare(`SELECT title, goal FROM kanban_board WHERE id = ?`)
      .get(run.rootCardId) as { title: string; goal: string | null } | undefined;
    const proposal = JSON.parse(this.store.getPlanJson(runId, revision)) as PlanProposal;
    const criteriaByNode: Record<string, string[]> = {};
    for (const n of proposal.nodes ?? []) criteriaByNode[n.label] = n.acceptance ?? [];
    const nodes = this.store.listNodes(runId, revision).map((n) => ({
      nodeId: n["node_id"] as string,
      kind: n["kind"] as string,
      status: n["status"] as string,
      outcome: (n["outcome"] as string | null) ?? null,
      attemptId: (n["attempt_id"] as string | null) ?? null,
    }));
    return {
      runId, revision, nodeId,
      request: { title: card?.title ?? `run ${runId}`, goal: card?.goal ?? null },
      requiredOutputs: proposal.requiredOutputs ?? [],
      criteriaByNode,
      nodes,
      failures: nodes
        .filter((n) => n.status === "failed")
        .map((n) => ({ nodeId: n.nodeId, outcome: n.outcome })),
      evidenceIds: [...new Set(nodes.map((n) => n.attemptId).filter((a): a is string => a !== null))],
      budgets: this.store.readBudgets(runId) as Record<string, { allowed: number; consumed: number }>,
    };
  }

  private requiredOutputsOf(runId: string): string[] {
    try {
      const revision = this.store.currentRevision(runId);
      if (revision === 0) return [];
      const proposal = JSON.parse(this.store.getPlanJson(runId, revision)) as PlanProposal;
      return proposal.requiredOutputs ?? [];
    } catch {
      return [];
    }
  }

  /** Union of node outputs declared by revisions 1..upto (for revision coverage). */
  private cumulativeOutputs(runId: string, uptoRevision: number): string[] {
    const out = new Set<string>();
    for (let rev = 1; rev <= uptoRevision; rev++) {
      try {
        const proposal = JSON.parse(this.store.getPlanJson(runId, rev)) as PlanProposal;
        for (const n of proposal.nodes ?? []) for (const o of n.outputs ?? []) out.add(o);
      } catch {
        // Missing/unreadable revision snapshot contributes nothing.
      }
    }
    return [...out];
  }

  // ── plan revisions: bounded next waves + targeted repairs (Task 3) ────
  //
  // A new revision never rewrites running work: non-terminal nodes of prior
  // revisions are cancelled first (attempt-level fencing of those nodes lands
  // with the worker-authority cutover in Task 5). Acceptance is monotonic:
  // required outputs may only grow — narrowing is rejected here and becomes a
  // visible input request in Task 4, never a silent scope reduction.

  submitPlanProposal(runId: string, proposal: PlanProposal, opts?: {
    baseRevision?: number; opId?: string;
    completesNode?: { revision: number; nodeId: string; outcome: string };
  }): AcceptedPlan {
    const run = this.requireLive(runId);
    const current = this.store.currentRevision(runId);
    if (opts?.baseRevision !== undefined && opts.baseRevision !== current) {
      throw new Error(`workflow runner: revision ${opts.baseRevision} stale for run ${runId} (current ${current})`);
    }
    const problems = this.validatePlan(proposal, this.cumulativeOutputs(runId, current));
    if (problems.length > 0) {
      const text = boundText(problems.map((p) => `${p.field}: ${p.reason}`).join("; "), 2000);
      const res = this.commitKind(run, "PlanRejected", { problems }, () => {
        const ok = this.store.consumeBudget(runId, "plan_revision");
        if (!ok) {
          if (opts?.opId) this.store.upsertOperation({ opId: opts.opId, runId, kind: "planning", status: "failed", resultJson: text });
          return { nextState: "failed" as const, failureCode: "plan_rejected", failureReason: text };
        }
        return { nextState: "planning" as const };
      });
      if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
      throw new Error(`workflow runner: plan revision rejected: ${text}`);
    }
    let baseline: string[] = [];
    try {
      baseline = (JSON.parse(this.store.getPlanJson(runId, 1)) as PlanProposal).requiredOutputs ?? [];
    } catch {
      baseline = [];
    }
    const dropped = baseline.filter((r) => !(proposal.requiredOutputs ?? []).includes(r));
    if (dropped.length > 0) {
      throw new Error(`workflow runner: revision weakens acceptance, dropped outputs: ${dropped.join(",")} (route through input request)`);
    }
    const revision = current + 1;
    const hostIds = proposal.nodes.map(
      (n, i) => `n${revision}_${i}_${n.label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24)}`,
    );
    const byLabel = new Map(proposal.nodes.map((n, j) => [n.label, hostIds[j] as string]));
    const byId = new Map(proposal.nodes.map((n, i) => [hostIds[i] as string, n]));
    let queued = 0;
    const res = this.commitKind(run, "PlanAccepted", { revision }, () => {
      // Replacement cancels prior non-terminal work but never rewrites it:
      // review nodes stay open (verdicts span revisions); the authoring
      // planning node completes with its proposal as the outcome.
      const spare = opts?.completesNode ? [opts.completesNode.nodeId] : [];
      this.store.cancelPriorNodes(runId, revision, spare);
      if (opts?.completesNode) {
        this.store.setNodeOutcome(
          runId, opts.completesNode.revision, opts.completesNode.nodeId,
          "succeeded", opts.completesNode.outcome,
        );
      }
      this.store.insertPlanRevision(runId, revision, JSON.stringify(proposal));
      this.store.insertNodes(
        proposal.nodes.map((n, i) => ({ runId, revision, nodeId: hostIds[i] as string, kind: n.kind })),
      );
      for (let i = 0; i < proposal.nodes.length; i++) {
        const n = proposal.nodes[i] as PlanNodeProposal;
        this.store.insertDeps(
          (n.dependsOn ?? []).map((dep) => ({
            runId, revision, nodeId: hostIds[i] as string, dependsOn: byLabel.get(dep) as string,
          })),
        );
      }
      for (const row of this.store.listNodes(runId, revision)) {
        const nodeId = row["node_id"] as string;
        if (this.store.hasUnsatisfiedDeps(runId, revision, nodeId)) continue;
        this.queueForNode(runId, run.generation, revision, nodeId, byId.get(nodeId)?.kind ?? "work", {});
        queued++;
      }
      if (opts?.opId) this.store.upsertOperation({ opId: opts.opId, runId, kind: "planning", revision, status: "succeeded" });
      return { nextState: "dispatched" as const };
    });
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
    return { revision, nodeIds: hostIds, queued };
  }

  // ── review verdicts (Task 3: narrow, host-validated) ──────────────────
  //
  // The reviewer judges; the runner applies. Mechanical validity and mandatory
  // checks run in code first (acceptance-criterion linkage below). One bounded
  // protocol correction for malformed verdicts; persistent malformed verdicts
  // fail the review with their own reason — never a fresh execution turn.

  submitVerdict(runId: string, nodeId: string, rawVerdict: ReviewVerdict): VerdictOutcome {
    const run = this.requireLive(runId);
    // Sanitize model-supplied text at the boundary (bounded diagnostics, req 12).
    const verdict: ReviewVerdict = rawVerdict.verdict === "accept" ? { verdict: "accept" }
      : rawVerdict.verdict === "cannot_assess" ? { verdict: "cannot_assess", reason: boundText(rawVerdict.reason, 2000) }
      : rawVerdict.verdict === "changes_required" ? {
          verdict: "changes_required",
          defects: (rawVerdict.defects ?? []).map((d) => ({
            criterion: boundText(d.criterion, 500), detail: boundText(d.detail, 2000),
          })),
        }
      : rawVerdict;
    const judged = this.store.currentRevision(runId);
    const home = this.locateReviewNode(runId, nodeId);
    if (home === null) {
      throw new Error(`workflow runner: no open review node ${nodeId} in run ${runId}`);
    }
    const malformed = this.checkVerdict(runId, judged, verdict);
    if (malformed !== null) {
      let corrected = false;
      const res = this.commitKind(run, "ReviewInvalid", { nodeId, judged, verdict, malformed }, () => {
        if (this.store.consumeBudget(runId, "protocol_correction")) {
          const ordinal = this.store.nextCommandOrdinal(runId, run.generation, nodeId, "review");
          this.store.queueCommand({
            runId, generation: run.generation, nodeId, action: "review", ordinal,
            payloadJson: JSON.stringify({ nodeId, revision: home, correctionOf: malformed }),
          });
          corrected = true;
          return {};
        }
        this.store.upsertOperation({ opId: opIdFor(runId, home, nodeId), runId, kind: "review", revision: home, status: "failed", resultJson: malformed });
        this.store.setNodeOutcome(runId, home, nodeId, "failed", malformed);
        return this.evaluateTerminal(runId, judged, `malformed verdict: ${malformed}`);
      });
      if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
      return corrected ? "correction_queued" : "failed";
    }
    if (verdict.verdict === "accept") {
      const res = this.commitKind(run, "ReviewAccepted", { nodeId, judged, home }, () => {
        this.requireNode(runId, home, nodeId, ["queued", "running"]);
        this.store.upsertOperation({ opId: opIdFor(runId, home, nodeId), runId, kind: "review", revision: home, status: "succeeded", resultJson: JSON.stringify({ ...verdict, judgedRevision: judged }) });
        this.store.setNodeOutcome(runId, home, nodeId, "succeeded", JSON.stringify({ ...verdict, judgedRevision: judged }));
        // Durable delivery obligation for the accepted revision (Task 4 executes
        // the send; the obligation exists from acceptance, never from delivery).
        // One obligation per review node, refreshed per acceptance round; each
        // round gets its own deliver command ordinal.
        this.store.insertDelivery(runId, nodeId, JSON.stringify({ revision: judged, acceptedAt: "now" }));
        this.store.queueCommand({
          runId, generation: run.generation, nodeId, action: "deliver",
          ordinal: this.store.nextCommandOrdinal(runId, run.generation, nodeId, "deliver"),
          payloadJson: JSON.stringify({ nodeId, revision: judged }),
        });
        return this.evaluateTerminal(runId, judged);
      });
      if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
      return "accepted";
    }
    if (verdict.verdict === "cannot_assess") {
      const res = this.commitKind(run, "ReviewUnassessable", { nodeId, judged, verdict }, () => {
        this.requireNode(runId, home, nodeId, ["queued", "running"]);
        this.store.upsertOperation({ opId: opIdFor(runId, home, nodeId), runId, kind: "review", revision: home, status: "failed", resultJson: JSON.stringify(verdict) });
        this.store.setNodeOutcome(runId, home, nodeId, "failed", verdict.reason);
        return this.evaluateTerminal(runId, judged, `review cannot assess: ${verdict.reason}`);
      });
      if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
      return "unassessable";
    }
    // changes_required with linked defects: bounded repair planning, then re-review
    // on the SAME node (which stays running across the repair revision).
    let repaired = false;
    const res = this.commitKind(run, "ReviewChangesRequested", { nodeId, judged, verdict }, () => {
      this.requireNode(runId, home, nodeId, ["queued", "running"]);
      if (!this.store.consumeBudget(runId, "review_repair")) {
        this.store.upsertOperation({ opId: opIdFor(runId, home, nodeId), runId, kind: "review", revision: home, status: "failed", resultJson: JSON.stringify(verdict) });
        this.store.setNodeOutcome(runId, home, nodeId, "failed", "repair allowance exhausted with unresolved defects");
        return this.evaluateTerminal(runId, judged, "repair allowance exhausted with unresolved defects");
      }
      const opId = `op-${runId}-repair-r${judged}-${nodeId}`;
      this.store.upsertOperation({ opId, runId, kind: "planning", revision: judged, status: "pending", resultJson: JSON.stringify({ purpose: "repair", defects: verdict.defects }) });
      this.store.queueCommand({
        runId, generation: run.generation, nodeId, action: "plan", ordinal: this.store.nextCommandOrdinal(runId, run.generation, nodeId, "plan"),
        payloadJson: JSON.stringify({ nodeId, revision: judged, purpose: "repair", defects: verdict.defects, opId }),
      });
      repaired = true;
      return {};
    });
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
    return repaired ? "repair_queued" : "failed";
  }

  /**
   * Locate the home revision of an open review node, newest first. A review
   * node outlives its revision: re-review after repair judges the latest
   * revision on the original node.
   */
  private locateReviewNode(runId: string, nodeId: string): number | null {
    const current = this.store.currentRevision(runId);
    for (let rev = current; rev >= 1; rev--) {
      const found = this.store.listNodes(runId, rev).find((n) => n["node_id"] === nodeId && n["kind"] === "review");
      if (found && (found["status"] === "queued" || found["status"] === "running")) return rev;
    }
    return null;
  }

  /** Machine-checkable verdict validity; returns a reason or null when valid. */
  private checkVerdict(runId: string, revision: number, verdict: ReviewVerdict): string | null {
    if (!verdict || typeof verdict.verdict !== "string") return "verdict kind missing";
    if (verdict.verdict !== "accept" && verdict.verdict !== "changes_required" && verdict.verdict !== "cannot_assess") {
      return `unknown verdict kind ${String((verdict as { verdict: unknown }).verdict)}`;
    }
    if (verdict.verdict === "accept") return null;
    if (verdict.verdict === "cannot_assess") {
      return typeof verdict.reason === "string" && verdict.reason.length > 0 ? null : "cannot_assess requires a reason";
    }
    if (!Array.isArray(verdict.defects) || verdict.defects.length === 0) {
      return "changes_required requires at least one defect";
    }
    let criteria: Set<string>;
    try {
      const proposal = JSON.parse(this.store.getPlanJson(runId, revision)) as PlanProposal;
      criteria = new Set<string>();
      for (const n of proposal.nodes ?? []) for (const c of n.acceptance ?? []) criteria.add(c);
    } catch {
      return "unreadable plan revision for criterion linkage";
    }
    for (let i = 0; i < verdict.defects.length; i++) {
      const d = verdict.defects[i] as { criterion?: unknown; detail?: unknown };
      if (typeof d?.criterion !== "string" || !criteria.has(d.criterion)) {
        return `defect[${i}] links to unknown criterion ${String(d?.criterion)}`;
      }
      if (typeof d?.detail !== "string" || d.detail.length === 0) {
        return `defect[${i}] needs a concrete detail`;
      }
    }
    return null;
  }

  // ── Task 4: failure remediation, cancellation, delivery, input ────
  //
  // Cancellation and acceptance serialize on run state/version: a cancel
  // committed before acceptance prevents it; late results after terminal
  // states are rejected loudly and change nothing.

  requestCancel(runId: string, cause: string): {
    cancelled: boolean; attemptsFenced: number; commandsCancelled: number; nodesCancelled: number;
  } {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`workflow runner: run ${runId} missing`);
    if (TERMINAL_RUN_STATES.includes(run.state)) return { cancelled: false, attemptsFenced: 0, commandsCancelled: 0, nodesCancelled: 0 };
    const reason = boundText(cause, 2000);
    let counts = { attemptsFenced: 0, commandsCancelled: 0, nodesCancelled: 0 };
    const res = this.commitKind(run, "CancelRequested", { cause: reason }, () => {
      counts = this.store.cancelRun(runId, run.rootCardId);
      return { nextState: "cancelled" as const, failureCode: "cancelled", failureReason: reason };
    });
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
    return { cancelled: true, ...counts };
  }

  /** Terminal failure outside node evaluation (breaker refusal, inspector verdict). */
  failRun(runId: string, code: string, reason: string): void {
    const run = this.requireLive(runId);
    const res = this.commitKind(run, "RunFailed", { code, reason }, () => ({
      nextState: "failed" as const, failureCode: code, failureReason: boundText(reason, 2000),
    }));
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
  }

  // ── input request/answer with durable resume ──────────────────────────

  requestInput(runId: string, question: string, criteria: string[], kind = "text"): string {
    const run = this.requireLive(runId);
    if (run.state === "awaiting_input") throw new Error(`workflow runner: run ${runId} already awaiting input`);
    const q = boundText(question, 2000);
    let inputId = "";
    const res = this.commitKind(run, "InputRequested", { question: q }, () => {
      inputId = this.store.insertInputRequest({
        runId, cardId: run.rootCardId, caseRef: `wf:${runId}`,
        question: q, criteria, kind,
      });
      this.store.queueCommand({
        runId, generation: run.generation, nodeId: "__input__", action: "notify", ordinal: 0,
        payloadJson: JSON.stringify({ kind: "input_requested", inputId }),
      });
      return { nextState: "awaiting_input" as const };
    });
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
    return inputId;
  }

  answerInput(inputId: string, response: string): { runId: string } {
    const answered = this.store.answerInputRequest(inputId, boundText(response, 2000));
    if (!answered || !answered.runId) throw new Error(`workflow runner: input ${inputId} unknown or already answered`);
    const run = this.requireLive(answered.runId);
    if (run.state !== "awaiting_input") {
      throw new Error(`workflow runner: run ${answered.runId} not awaiting input (stale answer)`);
    }
    const res = this.commitKind(run, "InputAnswered", { inputId }, () => {
      this.store.queueCommand({
        runId: run.runId, generation: run.generation, nodeId: "__input__", action: "notify",
        ordinal: this.store.nextCommandOrdinal(run.runId, run.generation, "__input__", "notify"),
        payloadJson: JSON.stringify({ kind: "input_answered", inputId }),
      });
      return { nextState: "executing" as const };
    });
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
    return { runId: run.runId };
  }

  // ── delivery execution (claim → send → mark; ambiguity → unknown) ─────

  executeDelivery(
    runId: string, nodeId: string,
    sender: {
      send(doc: { runId: string; nodeId: string; obligation: string; idempotenceKey: string }): string;
    },
  ): "acknowledged" | "failed" | "unknown" | "retry_queued" {
    this.requireLive(runId);
    const pending = this.store.findPendingCommand(runId, nodeId, "deliver");
    if (!pending) throw new Error(`workflow runner: no pending deliver command for ${runId}/${nodeId}`);
    const claimed = this.store.claimCommand(
      { runId, generation: pending.generation, nodeId, action: "deliver", ordinal: pending.ordinal }, "delivery",
    );
    if (!claimed) throw new Error(`workflow runner: deliver command for ${runId}/${nodeId} busy`);
    const key = { runId, generation: pending.generation, nodeId, action: "deliver" as const, ordinal: pending.ordinal };
    const delivery = this.store.getDelivery(runId, nodeId);
    if (!delivery) {
      throw new Error(`workflow runner: no delivery obligation for ${runId}/${nodeId} (never accepted)`);
    }
    if (delivery["outcome"] !== "pending") {
      this.store.completeCommand(key, "delivery", claimed.token);
      return delivery["outcome"] as "acknowledged" | "failed" | "unknown";
    }
    const attempts = this.store.bumpDeliveryAttempts(runId, nodeId);
    const idempotenceKey = `${runId}/${nodeId}/${attempts}`;
    let receipt: string;
    try {
      receipt = sender.send({
        runId, nodeId,
        obligation: delivery["obligation_json"] as string,
        idempotenceKey,
      });
    } catch (err) {
      if ((err as { definitive?: boolean }).definitive === true) {
        if (attempts < DELIVERY_MAX_ATTEMPTS) {
          this.store.completeCommand(key, "delivery", claimed.token);
          this.store.queueCommand({
            runId, generation: pending.generation, nodeId, action: "deliver",
            ordinal: this.store.nextCommandOrdinal(runId, pending.generation, nodeId, "deliver"),
            payloadJson: JSON.stringify({ nodeId, retryOf: attempts }),
          });
          return "retry_queued";
        }
        this.store.setDeliveryOutcome(runId, nodeId, "failed", JSON.stringify({ error: boundText((err as Error).message, 500) }));
        this.store.completeCommand(key, "delivery", claimed.token);
        return "failed";
      }
      // Ambiguous send (timeout, lost ack, unknown transport outcome):
      // explicitly unknown — never falsely acknowledged, never blindly resent.
      this.store.setDeliveryOutcome(runId, nodeId, "unknown", JSON.stringify({ idempotenceKey }));
      this.store.completeCommand(key, "delivery", claimed.token);
      return "unknown";
    }
    this.store.setDeliveryOutcome(runId, nodeId, "acknowledged", receipt);
    this.store.completeCommand(key, "delivery", claimed.token);
    this.settleIfDeliverable(runId);
    return "acknowledged";
  }

  /**
   * Re-evaluate terminal state after delivery settlement (Task 4): an
   * acknowledged delivery with all nodes terminal and no other pending
   * obligation completes the run. Never invents success — evaluateTerminal
   * decides from recorded node outcomes and the delivery gate.
   */
  private settleIfDeliverable(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run || TERMINAL_RUN_STATES.includes(run.state)) return;
    const revision = this.store.currentRevision(runId);
    const res = this.commitKind(run, "DeliverySettled", {}, () => this.evaluateTerminal(runId, revision));
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
  }

  // ── ClaimExpired inspection applier (Revision D–F trichotomy) ─────────

  inspectClaim(runId: string, key: {
    nodeId: string; action: CommandAction; ordinal: number; generation: number;
  }, expectedGen: number): string {
    const run = this.requireLive(runId);
    const payload = JSON.stringify({ key, expectedGen });
    const event: RunnerIngress = {
      eventId: `inspect-${runId}-${key.nodeId}-${key.action}-${key.ordinal}-${expectedGen}-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      runId, payloadHash: createHash("sha256").update(payload).digest("hex"),
      payloadJson: JSON.stringify({ kind: "ClaimExpired", body: { key, expectedGen } }),
      generation: run.generation, stateVersion: run.stateVersion,
    };
    const res = this.applyClaimExpired(run, key, expectedGen, event);
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
    const marker = this.store.getCommand({ runId, ...key });
    return `${res.disposition}:${marker?.status ?? "gone"}`;
  }

  private applyClaimExpired(
    run: WorkflowRunRow,
    key: { nodeId: string; action: CommandAction; ordinal: number; generation: number },
    expectedGen: number, event: RunnerIngress,
  ): CommitResult {
    return this.store.commitTransition(event, () => {
      const fullKey = { runId: run.runId, ...key };
      const cmd = this.store.getCommand(fullKey);
      if (!cmd || cmd.status !== "claimed") {
        return { noop: true }; // already settled — consume, change nothing.
      }
      if (cmd.inspectGen !== expectedGen - 1 || cmd.claimToken === null || cmd.owner === null) {
        return { noop: true }; // stale inspection — a newer one owns this claim.
      }
      // Terminal node with an open claim (recovered completion, prior verdict):
      // finish the orphaned command, change nothing else.
      const rev0 = this.store.currentRevision(run.runId);
      const pre = this.store.listNodes(run.runId, rev0).find((n) => n["node_id"] === key.nodeId);
      const preStatus = pre?.["status"] as string | undefined;
      if (preStatus !== undefined && preStatus !== "queued" && preStatus !== "running") {
        this.store.completeCommand(fullKey, cmd.owner, cmd.claimToken);
        return { noop: true };
      }
      const finish = (): TransitionEffect => {
        this.store.completeCommand(fullKey, cmd.owner as string, cmd.claimToken as string);
        return {};
      };
      if (key.action === "deliver") {
        const delivery = this.store.getDelivery(run.runId, key.nodeId);
        if (!delivery || delivery["outcome"] !== "pending") {
          finish();
          return { noop: true };
        }
        if (Number(delivery["attempts"]) === 0) {
          // Claimed but never sent: nothing went out — safe to requeue.
          this.store.releaseClaim(fullKey, cmd.owner, cmd.claimToken);
          return {};
        }
        // Send attempted without a recorded outcome: ambiguous by definition.
        this.store.setDeliveryOutcome(run.runId, key.nodeId, "unknown",
          JSON.stringify({ inspection: true }));
        finish();
        return {};
      }
      if (key.action === "review" || key.action === "plan") {
        // No backend observability for model invocations: count inconclusive,
        // fail terminally at the bound (never silently retry, never wait forever).
        return this.applyInconclusive(run, fullKey, expectedGen, () => {
          const rev = this.store.currentRevision(run.runId);
          const node = this.store.listNodes(run.runId, rev).find((n) => n["node_id"] === key.nodeId);
          const home = node ? rev : this.locateAnyRevision(run.runId, key.nodeId);
          if (home !== null) {
            this.store.upsertOperation({
              opId: opIdFor(run.runId, home, key.nodeId), runId: run.runId,
              kind: key.action === "review" ? "review" : "planning",
              revision: home, status: "failed", resultJson: "inspection cap reached",
            });
            this.store.setNodeOutcome(run.runId, home, key.nodeId, "failed", "inspection cap reached without verdict");
          }
        });
      }
      // dispatch: inspect the attempt by stable identity.
      const rev = this.store.currentRevision(run.runId);
      const node = this.store.listNodes(run.runId, rev).find((n) => n["node_id"] === key.nodeId);
      if (!node) {
        finish();
        return { noop: true }; // node gone (cancelled/superseded) — moot.
      }
      const cardId = node["worker_card_id"] as number | null;
      const latest = cardId === null ? null : this.store.latestAttemptForCard(cardId);
      if (!latest) {
        // No attempt ever started for this command: nothing ran — safe requeue.
        this.store.releaseClaim(fullKey, cmd.owner, cmd.claimToken);
        return {};
      }
      const lifecycle = latest["lifecycle"] as string;
      if (["completed", "failed", "cancelled", "timed_out"].includes(lifecycle)) {
        if (lifecycle === "completed") {
          // Lost completion found by inspection: recover result + successors.
          const result = this.store.readResult(latest["id"] as string);
          this.store.setNodeOutcome(run.runId, rev, key.nodeId, "succeeded",
            result ?? `{"recovered":"${latest["id"]}"}`, latest["id"] as string);
          for (const next of this.store.satisfyDependents(run.runId, rev, key.nodeId)) {
            this.queueForNode(run.runId, run.generation, rev, next, this.nodeKindOf(run.runId, rev, next), {});
          }
          finish();
          return this.evaluateTerminal(run.runId, rev);
        }
        // Did the CLAIMED round run? Compare attempt start against claim time
        // (60s grace for clock skew). Proven older → the round never started →
        // safe requeue. Proven newer → it ran and died → fail into policy
        // without blind retry. Unparseable → undecidable → unobservable path
        // below (never requeue on doubt).
        const started = dbTimeMillis(latest["started_at"]);
        const claimedAt = dbTimeMillis(cmd.claimedAt);
        const decided = !Number.isNaN(started) && !Number.isNaN(claimedAt);
        if (decided && started <= claimedAt - 60000) {
          this.store.releaseClaim(fullKey, cmd.owner, cmd.claimToken);
          return {};
        }
        if (decided) {
          this.store.setNodeOutcome(run.runId, rev, key.nodeId, "failed",
            `attempt ${latest["id"]} ${lifecycle} found at inspection`);
          finish();
          return this.evaluateTerminal(run.runId, rev, `attempt ${latest["id"]} ${lifecycle}`);
        }
      } else {
        // Non-terminal attempt: liveness hinges on the lease heartbeat.
        const lease = this.store.readLeaseSnapshot(latest["id"] as string);
        if (leaseFresh(lease)) {
          this.store.noteInspectionAlive(fullKey, expectedGen, COMMAND_CLAIM_LEASE_MIN);
          return {};
        }
      }
      return this.applyInconclusive(run, fullKey, expectedGen, () => {
        this.store.setNodeOutcome(run.runId, rev, key.nodeId, "failed", "observation_unknown");
      }, true);
    });
  }

  /** Shared inconclusive counter: reschedule below MAX, explicit unknown at MAX. */
  private applyInconclusive(
    run: WorkflowRunRow, fullKey: CommandKey, expectedGen: number,
    onMax: () => void, resolveRunUnknown = false,
  ): TransitionEffect {
    const cmd = this.store.getCommand(fullKey);
    const inconclusive = Number(cmd?.consecutiveInconclusive ?? 0) + 1;
    if (inconclusive >= MAX_CONSECUTIVE_INCONCLUSIVE) {
      onMax();
      if (resolveRunUnknown) {
        return {
          nextState: "failed", failureCode: "observation_unknown",
          failureReason: "5 consecutive inconclusive inspections; no retry without confirmed termination",
        };
      }
      const rev = this.store.currentRevision(run.runId);
      return this.evaluateTerminal(run.runId, rev, "inspection cap reached without verdict");
    }
    this.store.noteInspectionInconclusive(fullKey, expectedGen, inconclusive, COMMAND_CLAIM_LEASE_MIN);
    return {};
  }

  private locateAnyRevision(runId: string, nodeId: string): number | null {
    const current = this.store.currentRevision(runId);
    for (let rev = current; rev >= 1; rev--) {
      if (this.store.listNodes(runId, rev).some((n) => n["node_id"] === nodeId)) return rev;
    }
    return null;
  }

  private nodeKindOf(runId: string, revision: number, nodeId: string): string {
    const node = this.store.listNodes(runId, revision).find((n) => n["node_id"] === nodeId);
    return (node?.["kind"] as string) ?? "work";
  }

  // ── SHA handoff consumption ───────────────────────────────────────────

  acceptShaHandoff(payload: { rootCardId: number; stage: string; result: string; final: boolean }): string {
    payload = { rootCardId: payload.rootCardId, stage: boundText(payload.stage, 500), result: boundText(payload.result, 2000), final: payload.final };
    const run = this.store.findRunByCard(payload.rootCardId);
    if (!run) return "no-run:noop";
    if (TERMINAL_RUN_STATES.includes(run.state)) return "terminal:noop";
    const res = this.applyShaHandoff(run, payload, this.freshEvent(run, "ShaHandoff", payload));
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
    return `${res.disposition}`;
  }

  /** Shared applier so live and redriven handoffs execute identical writes. */
  private applyShaHandoff(
    run: WorkflowRunRow, payload: { rootCardId: number; stage: string; result: string; final: boolean },
    event: RunnerIngress,
  ): CommitResult {
    return this.store.commitTransition(event, () => {
      if (!payload.final) return { noop: true };
      // Final stage: ensure review dispatch for review nodes that need it:
      // queued+unblocked nodes, plus running nodes with no open review command
      // (reviewer died mid-review — re-queue with a fresh ordinal). Idempotent:
      // nodes with a pending/claimed review command are skipped.
      const rev = this.store.currentRevision(run.runId);
      let queued = 0;
      for (const row of this.store.listNodes(run.runId, rev)) {
        if (row["kind"] !== "review") continue;
        const nodeId = row["node_id"] as string;
        const status = row["status"] as string;
        if (status !== "queued" && status !== "running") continue;
        if (this.store.hasUnsatisfiedDeps(run.runId, rev, nodeId)) continue;
        if (this.store.hasCommand(run.runId, nodeId, "review", "pending")) continue;
        if (status === "running" && this.store.hasCommand(run.runId, nodeId, "review", "claimed")) continue;
        this.queueForNode(run.runId, run.generation, rev, nodeId, "review", {},
          this.store.nextCommandOrdinal(run.runId, run.generation, nodeId, "review"));
        queued++;
      }
      return queued > 0 ? {} : { noop: true };
    });
  }

  // ── breaker refusal ───────────────────────────────────────────────────

  submitBreakerRefused(runId: string, nodeId: string, resource: string, ordinal = 0): string {
    const run = this.requireLive(runId);
    resource = boundText(resource, 500);
    const rev = this.store.currentRevision(runId);
    const res = this.commitKind(run, "BreakerRefused", { nodeId, resource }, () => {
      const node = this.store.listNodes(runId, rev).find((n) => n["node_id"] === nodeId);
      if (!node || (node["status"] !== "queued" && node["status"] !== "running")) return { noop: true };
      this.store.cancelCommand({ runId, generation: run.generation, nodeId, action: "dispatch", ordinal });
      if (this.isOptionalNode(runId, rev, nodeId)) {
        this.store.setNodeOutcome(runId, rev, nodeId, "skipped", `resource refused: ${resource}`);
        this.store.satisfyDependents(runId, rev, nodeId);
        return this.evaluateTerminal(runId, rev);
      }
      // Required work refused: fail fast AND cancel the run's leftover pending
      // commands so no drain rediscovers them (the run is terminal; the audit
      // ignores terminal runs, but dangling rows are not left behind).
      this.store.cancelPendingCommands(runId);
      return { nextState: "failed" as const, failureCode: "resource_unavailable", failureReason: `resource refused: ${resource}` };
    });
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
    return res.disposition;
  }

  // ── drain + recovery + audit ──────────────────────────────────────────

  drain(limit: number, ports: DrainPorts, opts?: DrainOpts): number {
    const policy = opts?.policy;
    const route = (cmd: CommandRow): { owner: string; start: () => void } => {
      if (!isJobPorts(ports) || cmd.action === "dispatch" || cmd.action === "deliver" || cmd.action === "notify") {
        const exec = isJobPorts(ports) ? ports.executor : ports;
        return { owner: exec.name, start: () => exec.dispatch(cmd) };
      }
      if (cmd.action === "review") {
        const backend = (ports as { reviewer: ReviewBackend }).reviewer;
        return {
          owner: backend.name,
          start: () => {
            const payload = JSON.parse(cmd.payloadJson) as { nodeId: string; revision: number };
            this.store.upsertOperation({
              opId: opIdFor(cmd.runId, payload.revision, cmd.nodeId),
              runId: cmd.runId, kind: "review", revision: payload.revision, status: "running",
            });
            backend.startReview(cmd, this.assembleBrief(cmd.runId, this.store.currentRevision(cmd.runId), cmd.nodeId));
          },
        };
      }
      const planner = (ports as { planner: PlannerBackend }).planner;
      return {
        owner: planner.name,
        start: () => {
          const payload = JSON.parse(cmd.payloadJson) as {
            nodeId: string; revision: number | null; purpose: PlanningInput["purpose"];
            defects?: Array<{ criterion: string; detail: string }>; opId?: string;
          };
          this.store.upsertOperation({
            opId: payload.opId ?? opIdFor(cmd.runId, payload.revision ?? 0, cmd.nodeId),
            runId: cmd.runId, kind: "planning", revision: payload.revision, status: "running",
          });
          planner.startPlanning(cmd, {
            runId: cmd.runId, revision: payload.revision, purpose: payload.purpose,
            defects: payload.defects ?? [], requiredOutputs: this.requiredOutputsOf(cmd.runId),
          });
        },
      };
    };
    let dispatched = 0;
    let firstError: unknown = null;
    const keyOf = (cmd: CommandRow) => ({
      runId: cmd.runId, generation: cmd.generation,
      nodeId: cmd.nodeId, action: cmd.action, ordinal: cmd.ordinal,
    });
    for (const cmd of this.store.drainPendingCommands(limit)) {
      // Resource policy precedes the claim: refused work is never claimed,
      // and refusal resolves immediately (fail or skip) — never fuse deferral.
      if (policy && cmd.action === "dispatch") {
        let resource: string | undefined;
        try {
          resource = (JSON.parse(cmd.payloadJson) as { resource?: string }).resource;
        } catch {
          resource = undefined;
        }
        if (policy.check({ runId: cmd.runId, action: cmd.action, resource }) === "refused") {
          try {
            this.submitBreakerRefused(cmd.runId, cmd.nodeId, resource ?? "default", cmd.ordinal);
          } catch (err) {
            // A run failed by an earlier refusal in this same drain pass leaves
            // terminal leftovers behind: skip them (their commands were already
            // cancelled by the failing commit), surface anything else.
            const state = this.store.getRun(cmd.runId)?.state;
            if (state === undefined || (TERMINAL_RUN_STATES as string[]).includes(state)) continue;
            if (firstError === null) firstError = err;
          }
          continue;
        }
      }
      const target = route(cmd);
      const claimed = this.store.claimCommand(
        { runId: cmd.runId, generation: cmd.generation, nodeId: cmd.nodeId, action: cmd.action, ordinal: cmd.ordinal },
        target.owner,
      );
      if (!claimed) continue; // lost race — another drainer won it.
      if (cmd.action !== "notify" && cmd.action !== "deliver") {
        // Track execution state for job commands (dispatch/review/plan).
        // Terminal-node guard applies to dispatch only: review/plan nodes are
        // driven by verdicts/proposals, and their liveness lives in the op row.
        if (cmd.action === "dispatch") {
          // A completion may have committed while this command waited (wake
          // redelivery race): never dispatch work for an already-terminal node.
          // Complete the stale command instead — no duplicate execution.
          const revision = this.store.currentRevision(cmd.runId);
          const node = this.store.listNodes(cmd.runId, revision).find((n) => n["node_id"] === cmd.nodeId);
          const status = node?.["status"] as string | undefined;
          if (status !== "queued" && status !== "running") {
            this.store.completeCommand(
              { runId: cmd.runId, generation: cmd.generation, nodeId: cmd.nodeId, action: cmd.action, ordinal: cmd.ordinal },
              target.owner, claimed.token,
            );
            continue;
          }
          this.store.markNodeRunning(cmd.runId, revision, cmd.nodeId);
        } else {
          const payload = JSON.parse(cmd.payloadJson) as { revision?: number | null };
          if (typeof payload.revision === "number") {
            this.store.markNodeRunning(cmd.runId, payload.revision, cmd.nodeId);
          }
        }
      }
      try {
        target.start();
      } catch (err) {
        // Capacity refusal releases the claim for redrive (the lease would
        // cover it, but prompt release keeps the queue fluid). Any other port
        // error leaves the claim for lease redrive and is reported at the end:
        // one bad executor must not wedge the whole drain, and failures must
        // surface instead of vanishing.
        if (err instanceof CapacityBusy) {
          this.store.releaseClaim(keyOf(cmd), target.owner, claimed.token);
          continue;
        }
        if (firstError === null) firstError = err;
        continue;
      }
      dispatched++;
    }
    if (dispatched === 0 && firstError !== null) throw firstError;
    return dispatched;
  }

  startupRecovery(port?: ExecutionPort): { redrivenIngress: number; pendingCommands: number } {
    // Re-drive persisted-but-unapplied ingress with STORED identity (idempotent
    // by event_id): crash between commit and wake, or a handoff persisted
    // without runner contact. Terminal runs' leftovers are consumed as noop.
    let redriven = 0;
    for (const row of this.store.listUnappliedIngress(100)) {
      const eventId = row["event_id"] as string;
      const atRunId = row["run_id"] as string;
      const hash = row["payload_hash"] as string;
      const payloadJson = row["payload_json"] as string;
      let parsed: { kind: string; body: Record<string, unknown> };
      try {
        parsed = JSON.parse(payloadJson) as { kind: string; body: Record<string, unknown> };
      } catch {
        continue;
      }
      const run = this.store.getRun(atRunId);
      if (!run) continue;
      if (TERMINAL_RUN_STATES.includes(run.state)) {
        this.store.consumeIngressNoop(eventId);
        redriven++;
        continue;
      }
      const event: RunnerIngress = {
        eventId, runId: atRunId, payloadHash: hash, payloadJson,
        generation: run.generation, stateVersion: run.stateVersion,
      };
      try {
        if (parsed.kind === "AttemptSucceeded") {
          const b = parsed.body;
          this.applyAttemptSucceeded(run, this.store.currentRevision(atRunId),
            b["nodeId"] as string, b["attemptId"] as string, b["artifactsJson"] as string, event);
          redriven++;
        } else if (parsed.kind === "AttemptFailed") {
          const b = parsed.body;
          this.applyAttemptFailed(run, this.store.currentRevision(atRunId),
            b["nodeId"] as string, b["attemptId"] as string,
            b["cause"] as string, b["retrySafe"] as boolean, event);
          redriven++;
        } else if (parsed.kind === "ClaimExpired") {
          const b = parsed.body as {
            key: { nodeId: string; action: CommandAction; ordinal: number; generation: number };
            expectedGen: number;
          };
          this.applyClaimExpired(run, b.key, b.expectedGen, event);
          redriven++;
        } else if (parsed.kind === "ShaHandoff") {
          const b = parsed.body as { rootCardId: number; stage: string; result: string; final: boolean };
          this.applyShaHandoff(run, b, event);
          redriven++;
        }
        // Other kinds belong to their owner (planning/review/input/delivery
        // jobs); recovery leaves them received for the audit to observe
        // (deliberately NOT counted: nothing was redriven).
      } catch {
        // Recovery redrive must never throw past boot: the next audit pass
        // re-examines the same durable state.
      }
    }
    if (port) {
      for (const root of this.store.listAuditRoots(0, 100)) port.reconcileLiveAttempts?.(root.runId);
    }
    return { redrivenIngress: redriven, pendingCommands: this.store.countPendingCommands() };
  }

  auditTick(cursor: number): {
    nextCursor: number;
    checked: number;
    lawful: string[];
    ownerless: string[];
    dueInspections: Array<{ runId: string; claimToken: string; inspectGen: number }>;
  } {
    const roots = this.store.listAuditRoots(cursor, 100);
    const lawful: string[] = [];
    const ownerless: string[] = [];
    const dueInspections: Array<{ runId: string; claimToken: string; inspectGen: number }> = [];
    let nextCursor = cursor;
    for (const root of roots) {
      nextCursor = Math.max(nextCursor, root.rootCardId);
      // Admitted/planning runs await plan admission (a durable planning command
      // from Task 3); they are lawfully pending, never ownerless.
      if (root.state === "admitted" || root.state === "planning") {
        lawful.push(root.runId);
        continue;
      }
      const p = this.store.probeRun(root.runId, root.rootCardId);
      if (p.pending || p.freshClaim || p.liveAttempt || p.pendingInput || p.openOp || p.pendingDelivery) {
        lawful.push(root.runId);
      } else if (p.dueClaim) {
        lawful.push(root.runId); // suspect claim under inspection — never failure.
        for (const d of this.store.dueInspections(root.runId, 10)) {
          dueInspections.push({ runId: root.runId, claimToken: d.claimToken, inspectGen: d.inspectGen });
        }
      } else {
        ownerless.push(root.runId);
      }
    }
    return { nextCursor, checked: roots.length, lawful, ownerless, dueInspections };
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * Queue the command for a node by kind, creating the planning/review job
   * record for non-dispatch actions. Node kind selects the command action:
   * work/synthesis/delivery → dispatch (executor), review → review (reviewer),
   * planning → plan (planner).
   */
  private queueForNode(runId: string, generation: number, revision: number, nodeId: string, kind: string, payload: Record<string, unknown>, ordinal = 0): void {
    const action = kind === "review" ? "review" : kind === "planning" ? "plan" : "dispatch";
    // Planner guidance (single-open review op per revision): one review node
    // per revision; parallel review branches serialize through re-review.
    this.store.queueCommand({
      runId, generation, nodeId, action, ordinal,
      payloadJson: JSON.stringify({
        nodeId, revision, ...payload,
        ...(kind === "planning" ? { purpose: "next_wave" } : {}),
      }),
    });
    if (action === "review" || action === "plan") {
      this.store.upsertOperation({
        opId: opIdFor(runId, revision, nodeId),
        runId, kind: action === "review" ? "review" : "planning",
        revision, status: "pending",
      });
    }
  }  /** Commit one ingress with a FRESH host identity. */
  private commitKind(run: WorkflowRunRow, kind: string, body: unknown, apply: () => TransitionEffect): CommitResult {
    return this.store.commitTransition(this.freshEvent(run, kind, body), () => apply());
  }

  /** Shared applier so live and redriven paths execute identical writes. */
  private applyAttemptSucceeded(
    run: WorkflowRunRow, revision: number, nodeId: string, attemptId: string,
    artifactsJson: string, event: RunnerIngress,
  ): CommitResult {
    return this.store.commitTransition(event, () => {
      this.requireNode(run.runId, revision, nodeId, ["queued", "running"]);
      this.store.setNodeOutcome(run.runId, revision, nodeId, "succeeded", artifactsJson, attemptId);
      const unblocked = this.store.satisfyDependents(run.runId, revision, nodeId);
      const kinds = new Map(
        this.store.listNodes(run.runId, revision).map((n) => [n["node_id"] as string, n["kind"] as string]),
      );
      for (const next of unblocked) {
        this.queueForNode(run.runId, run.generation, revision, next, kinds.get(next) ?? "work", {});
      }
      return this.evaluateTerminal(run.runId, revision);
    });
  }

  private applyAttemptFailed(
    run: WorkflowRunRow, revision: number, nodeId: string, attemptId: string,
    cause: string, retrySafe: boolean, event: RunnerIngress,
  ): CommitResult {
    return this.store.commitTransition(event, () => {
      this.requireNode(run.runId, revision, nodeId, ["queued", "running"]);
      const optional = this.isOptionalNode(run.runId, revision, nodeId);
      if (!optional && retrySafe && this.store.consumeBudget(run.runId, "work_retry")) {
        const ordinal = this.store.nextCommandOrdinal(run.runId, run.generation, nodeId, "dispatch");
        this.store.setNodeOutcome(run.runId, revision, nodeId, "running", cause, attemptId);
        this.store.queueCommand({
          runId: run.runId, generation: run.generation, nodeId, action: "dispatch", ordinal,
          payloadJson: JSON.stringify({ nodeId, revision, retryOf: attemptId, cause }),
        });
        return {};
      }
      this.store.setNodeOutcome(run.runId, revision, nodeId, "failed", cause, attemptId);
      if (optional) {
        // Explicit optional-input policy: release dependents to proceed
        // without the optional input (never silently skip required work).
        this.store.satisfyDependents(run.runId, revision, nodeId);
      } else {
        this.store.skipDependents(run.runId, revision, nodeId);
      }
      return this.evaluateTerminal(run.runId, revision, `node ${nodeId} failed: ${cause}`);
    });
  }

  private freshEvent(run: WorkflowRunRow, kind: string, body: unknown): RunnerIngress {
    const payloadJson = JSON.stringify({ kind, body });
    return {
      eventId: `${kind}-${run.runId}-${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      runId: run.runId,
      payloadHash: createHash("sha256").update(payloadJson).digest("hex"),
      payloadJson,
      generation: run.generation,
      stateVersion: run.stateVersion,
    };
  }

  private requireLive(runId: string): WorkflowRunRow {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`workflow runner: run ${runId} missing`);
    if (TERMINAL_RUN_STATES.includes(run.state)) {
      throw new Error(`workflow runner: run ${runId} terminal (${run.state}); late result rejected`);
    }
    return run;
  }

  private requireNode(runId: string, revision: number, nodeId: string, allowed: string[]): void {
    const nodes = this.store.listNodes(runId, revision);
    const node = nodes.find((n) => n["node_id"] === nodeId);
    if (!node) throw new Error(`workflow runner: node ${nodeId} missing in run ${runId}`);
    if (!allowed.includes(node["status"] as string)) {
      throw new Error(`workflow runner: node ${nodeId} in status ${node["status"]}; conflicts with completion`);
    }
  }

  private isOptionalNode(runId: string, revision: number, nodeId: string): boolean {
    try {
      const proposal = JSON.parse(this.store.getPlanJson(runId, revision)) as PlanProposal;
      const prefix = `n${revision}_`;
      for (const n of proposal.nodes ?? []) {
        const id = `${prefix}${proposal.nodes.indexOf(n)}_${n.label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24)}`;
        if (id === nodeId) return n.optional === true;
      }
    } catch {
      // Unreadable plan snapshot: fail closed — treat as required.
    }
    return false;
  }

  /** Pure read-only terminal evaluation (no writes; appliers own all mutations). */
  private evaluateTerminal(
    runId: string, revision: number, failureCause?: string,
  ): { nextState?: WorkflowRunState; failureCode?: string | null; failureReason?: string | null } {
    const nodes = this.store.listNodes(runId, revision);
    if (nodes.length === 0) {
      return { nextState: "failed", failureCode: "no_workers", failureReason: "plan admitted zero executable nodes" };
    }
    const open = nodes.filter((n) => n["status"] === "queued" || n["status"] === "running");
    if (open.length > 0) return {};
    // A running review node anywhere in the run means acceptance is undecided:
    // repair waves must re-review, never terminally succeed past the verdict.
    for (let rev = 1; rev <= revision; rev++) {
      const pendingReview = this.store.listNodes(runId, rev).some((n) => n["kind"] === "review" && n["status"] === "running");
      if (pendingReview) return {};
    }
    // Delivery gate (Task 3 creates the obligation at review acceptance; Task 4
    // fulfills it): accepted content with an unacknowledged delivery is not success.
    if (this.store.hasPendingDelivery(runId)) return {};
    let policy: { allowPartial: boolean; requiredOutputs: string[]; optionalIds: Set<string>; outputsByNode: Map<string, string[]> };
    try {
      const proposal = JSON.parse(this.store.getPlanJson(runId, revision)) as PlanProposal;
      const optionalIds = new Set<string>();
      const outputsByNode = new Map<string, string[]>();
      proposal.nodes.forEach((n, i) => {
        const id = `n${revision}_${i}_${n.label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24)}`;
        if (n.optional === true) optionalIds.add(id);
        outputsByNode.set(id, n.outputs ?? []);
      });
      policy = { allowPartial: proposal.allowPartial === true, requiredOutputs: proposal.requiredOutputs ?? [], optionalIds, outputsByNode };
    } catch {
      // Unreadable plan snapshot: fail closed, never silently succeed.
      return {
        nextState: "failed", failureCode: "node_failed",
        failureReason: failureCause ?? "node failure with unreadable acceptance policy",
      };
    }
    const failedRequired = nodes
      .filter((n) => n["status"] === "failed" && !policy.optionalIds.has(n["node_id"] as string))
      .map((n) => n["node_id"] as string);
    if (failedRequired.length === 0) return { nextState: "succeeded" };
    if (policy.allowPartial) {
      const produced = new Set<string>();
      for (const n of nodes) {
        if (n["status"] !== "succeeded") continue;
        for (const o of policy.outputsByNode.get(n["node_id"] as string) ?? []) produced.add(o);
      }
      const missing = policy.requiredOutputs.filter((r) => !produced.has(r));
      if (missing.length === 0) {
        return {
          nextState: "succeeded",
          failureReason: `partial: dropped nodes ${failedRequired.join(",")}, all required outputs produced`,
        };
      }
      return {
        nextState: "failed", failureCode: "node_failed",
        failureReason: failureCause ?? `required outputs missing: ${missing.join(",")}`,
      };
    }
    return {
      nextState: "failed",
      failureCode: "node_failed",
      failureReason: failureCause ?? `nodes failed: ${failedRequired.join(",")}`,
    };
  }
}
