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
  type BudgetScope,
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

  validatePlan(proposal: PlanProposal): PlanDiagnostic[] {
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
    // Required-output coverage.
    const provided = new Set<string>();
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
    const problems = this.validatePlan(proposal);
    if (problems.length > 0) {
      // Invalid proposal: no worker side effects. Each rejection consumes the
      // plan_revision allowance; exhaustion fails the run with the diagnostics.
      const text = problems.map((p) => `${p.field}: ${p.reason}`).join("; ");
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
      for (const row of this.store.listNodes(runId, revision)) {
        const nodeId = row["node_id"] as string;
        if (this.store.hasUnsatisfiedDeps(runId, revision, nodeId)) continue;
        this.store.queueCommand({
          runId, generation: run.generation, nodeId, action: "dispatch", ordinal: 0,
          payloadJson: JSON.stringify({ nodeId, revision }),
        });
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
    const res = this.applyAttemptFailed(run, revision, nodeId, attemptId, cause, retrySafe,
      this.freshEvent(run, "AttemptFailed", { nodeId, attemptId, cause }));
    if (res.disposition === "conflict") throw new Error(`workflow runner: ${res.diagnostics}`);
  }

  // ── drain + recovery + audit ──────────────────────────────────────────

  drain(limit: number, port: ExecutionPort): number {
    let dispatched = 0;
    for (const cmd of this.store.drainPendingCommands(limit)) {
      const claimed = this.store.claimCommand(
        { runId: cmd.runId, generation: cmd.generation, nodeId: cmd.nodeId, action: cmd.action, ordinal: cmd.ordinal },
        port.name,
      );
      if (!claimed) continue; // lost race — another drainer won it.
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
            port.name, claimed.token,
          );
          continue;
        }
        this.store.markNodeRunning(cmd.runId, revision, cmd.nodeId);
      }
      port.dispatch(claimed.row);
      dispatched++;
    }
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
        } else if (parsed.kind === "AttemptFailed") {
          const b = parsed.body;
          this.applyAttemptFailed(run, this.store.currentRevision(atRunId),
            b["nodeId"] as string, b["attemptId"] as string,
            b["cause"] as string, b["retrySafe"] as boolean, event);
        }
        // Other kinds belong to their owner (planning/review/input/delivery
        // jobs); recovery leaves them received for the audit to observe.
        redriven++;
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

  /** Commit one ingress with a FRESH host identity. */
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
      for (const next of unblocked) {
        this.store.queueCommand({
          runId: run.runId, generation: run.generation, nodeId: next, action: "dispatch", ordinal: 0,
          payloadJson: JSON.stringify({ nodeId: next, revision }),
        });
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
