import { existsSync, statSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { normalizeContract, createContractId, createAttemptId, validateEnvelope, isValidWorkspaceAlias } from "./worker-contract.js";
import { resolveWorkerExecutorIntent } from "./worker-executor-routing.js";
import { logWarn } from "./logger.js";
import { logSwarmTrace } from "./swarm-trace.js";
import { nerve } from "./nerve.js";
import { authorizeActiveProjectWork, emitProjectAuthorityRejection, type ProjectMutationAuthority } from "./project-acceptance/project-review-store.js";
import type { WorkerAcceptanceContractV1, WorkerResultEnvelopeV1, CriterionStatus, VerificationObservation, ArtifactObservation, RetryContext } from "./worker-contract.js";
import type { TaskDatabase } from "./tasks/kanban-board.js";
import type { ContractRow } from "./worker-supervision-store.js";
import { ProjectReviewStore } from "./project-acceptance/project-review-store.js";
import { validateCriterionMapping } from "./project-acceptance/project-contract.js";
import { rootCriterionIds } from "./project-acceptance/project-criterion-coverage.js";
import { loadPiConfig } from "./pi-executor/config.js";

const TAG = "worker-supervision-service";
const MAX_RESULT_LENGTH = 500;
const MAX_CHECK_OUTPUT_LENGTH = 10_000;

/**
 * Return a stable admission error when a child claims root criteria it cannot
 * support, or when a supervised child under a contract-bearing root omits the
 * mapping entirely (#1604 R3, #1605 R2). Only DELEGATED root criteria are legal
 * mapping targets — Orc-owned criteria are rejected as bad references. A root
 * card with no project contract is unaffected; an Orc-only root admits
 * unmapped children but rejects mappings to Orc-owned ids.
 */
export function validateWorkerRootCriteria(
  rootCardId: number,
  childContractId: string,
  supportsRootCriteria: readonly string[],
): string | undefined {
  const legal = rootCriterionIds(rootCardId);
  if (legal === undefined) return undefined; // no project contract → unchanged

  if (legal.length === 0) {
    // #1605: an Orc-only root has no delegable criteria — an empty mapping is
    // valid, but a mapping referencing (Orc-owned) ids is a bad reference.
    if (supportsRootCriteria.length > 0) {
      return `root-criterion mapping rejected: no delegable root criteria for project #${rootCardId} — all criteria are Orc-owned and cannot be mapped to Workers`;
    }
    return undefined;
  }

  if (supportsRootCriteria.length === 0) {
    return `supports_root_criteria is required for supervised children of project #${rootCardId}; `
      + `declare a JSON array of delegated root criterion ids from: ${legal.join(", ")} (exact ids, case-sensitive)`;
  }

  const reviewStore = new ProjectReviewStore();
  const rootContractRow = reviewStore.getContractByProjectCardId(rootCardId);
  if (!rootContractRow) {
    return `root contract not found for project ${rootCardId}; cannot validate criterion mapping`;
  }
  const rootContract = JSON.parse(rootContractRow.contract_json) as import("./project-acceptance/project-contract.js").ProjectAcceptanceContract;
  const mappingErrors = validateCriterionMapping(rootContract, {
    child_contract_id: childContractId || "(pending)",
    supports_root_criteria: supportsRootCriteria,
  });
  if (mappingErrors.length > 0) {
    return `root-criterion mapping rejected: ${mappingErrors.map(e => e.message).join("; ")}`;
  }
  return undefined;
}

function isWithinWorkspace(workingDir: string, candidate: string): boolean {
  try {
    const base = resolve(workingDir);
    const target = resolve(candidate);
    const baseReal = realpathSync(base);
    const targetReal = realpathSync(target);
    const rel = relative(baseReal, targetReal);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  } catch {
    return false;
  }
}

/** Map internal executor names to the stable Worker result-contract vocabulary. */

export class WorkerSupervisionService {
  private store: WorkerSupervisionStore;

  constructor(db?: TaskDatabase) {
    this.store = new WorkerSupervisionStore(db);
  }

  createChild(
    rawGoal: string,
    rootCardId: number,
    authoredBy: string,
    opts?: {
      cardId?: number;
      title?: string;
      source?: string;
      priority?: string;
      criteria?: Array<{ id: string; description: string }>;
      expectedArtifacts?: Array<{ id: string; kind: "file" | "directory" | "report" | "logical"; ref: string; required: boolean; criterion_ids: string[] }>;
      verificationCommands?: Array<{ id: string; argv: string[]; cwd?: string; timeout_ms: number; criterion_ids: string[] }>;
      requiredCapabilities?: string[];
      supportsRootCriteria?: string[];
      limits?: { max_duration_ms?: number; max_tokens?: number };
      contractId?: string;
      attemptId?: string;
      workspaceAlias?: string;
      /** #1644: immutable project authority. Never supplied by tool arguments
       *  beyond the bound Orc invocation context; when absent it is derived
       *  from the durable root state at creation (repair path). */
      authority?: { projectCardId: number; projectGeneration: number; scheduledRunId?: string };
    },
  ): { contract: WorkerAcceptanceContractV1; attemptId: string; cardId: number } | { error: string } {
    // A bound Orc context owns the root identity. The parent/root argument is
    // only a legacy/repair input and must not be able to redirect a supervised
    // child into another project.
    const boundRootCardId = opts?.authority?.projectCardId ?? rootCardId;
    if (opts?.cardId !== undefined && this.store.contractExists(opts.cardId)) {
      return { error: `card #${opts.cardId} already has a contract` };
    }

    if (!opts?.criteria || opts.criteria.length === 0) {
      return { error: "supervised children require at least one acceptance criterion; goal-only supervised dispatch is rejected" };
    }

    // #1638: an alias that is not configured on this host is rejected at
    // contract creation — coding work never silently falls back to Spin.
    // A disabled/incompatible Pi is a runtime eligibility failure settled by
    // the generic dispatch path, not a contract-creation rejection.
    if (opts?.workspaceAlias) {
      const aliasErrors = validateConfiguredWorkspaceAlias(opts.workspaceAlias);
      if (aliasErrors.length > 0) return { error: `workspace_alias rejected: ${aliasErrors.join("; ")}` };
    }

    // #1604 R3: a supervised child under a contract-bearing root must declare
    // the root criteria it supports; validated unconditionally so an omitted
    // mapping is rejected here, at spawn time, not at settlement.
    const mappingError = validateWorkerRootCriteria(boundRootCardId, opts?.contractId ?? "(pending)", opts?.supportsRootCriteria ?? []);
    if (mappingError) return { error: mappingError };

    const contractId = opts?.contractId ?? createContractId();
    const raw: Record<string, unknown> = {
      schema_version: 1,
      id: contractId,
      goal: rawGoal,
      criteria: opts.criteria,
      provenance: {
        root_card_id: boundRootCardId,
        card_id: opts?.cardId ?? 0,
        authored_by: authoredBy,
        created_at: new Date().toISOString(),
      },
    };
    if (opts?.expectedArtifacts && opts.expectedArtifacts.length > 0) {
      raw["expected_artifacts"] = opts.expectedArtifacts;
    }
    if (opts?.verificationCommands && opts.verificationCommands.length > 0) {
      raw["verification_commands"] = opts.verificationCommands;
    }
    if (opts?.requiredCapabilities && opts.requiredCapabilities.length > 0) {
      raw["required_capabilities"] = opts.requiredCapabilities;
    }
    if (opts?.supportsRootCriteria && opts.supportsRootCriteria.length > 0) {
      raw["supports_root_criteria"] = opts.supportsRootCriteria;
    }
    if (opts?.workspaceAlias) {
      raw["workspace_alias"] = opts.workspaceAlias;
    }
    if (opts?.limits && Object.keys(opts.limits).length > 0) {
      raw["limits"] = opts.limits;
    }

    const normalized = normalizeContract(raw);
    if (!normalized.ok) {
      return { error: `contract validation failed: ${normalized.errors.map(e => e.message).join("; ")}` };
    }

    let result: { attemptId: string; cardId: number };
    try {
      result = this.store.db.transaction<{ attemptId: string; cardId: number }>(() => {
        // #1644: the immutable authority tuple is resolved once, inside the
        // mutating transaction, and persisted on the attempt. A caller-supplied
        // authority (Orc invocation context) is checked against the durable
        // root; the repair path derives it from the current durable state.
        const rootCard = this.store.db.prepare(`SELECT source, source_id FROM kanban_board WHERE id = ?`).get(boundRootCardId) as { source: string | null; source_id: string | null } | undefined;
        const supervision = this.store.db.prepare(`SELECT generation FROM project_supervision WHERE project_card_id = ?`).get(boundRootCardId) as { generation: number } | undefined;
        // A bound authority is immutable: if it is present, do not fill a
        // missing scheduled run ID from current durable state. Only the
        // repair path (no bound authority) may derive the run identity at
        // creation time.
        const scheduledRunId = opts?.authority !== undefined
          ? opts.authority.scheduledRunId
          : (rootCard?.source === "task" && rootCard.source_id ? rootCard.source_id : undefined);
        // #1644: the root card ID comes from the parent chain, never from a
        // caller-chosen value; only the bound generation (Orc context) and the
        // durable run identity are admitted into the tuple.
        const authority: ProjectMutationAuthority = {
          projectCardId: boundRootCardId,
          projectGeneration: opts?.authority?.projectGeneration ?? supervision?.generation ?? 1,
          scheduledRunId,
        };
        const rejection = authorizeActiveProjectWork(this.store.db, authority);
        if (rejection) {
          emitProjectAuthorityRejection("child_creation", authority, rejection);
          throw new Error(`project mutation rejected: ${rejection}`);
        }

        let cardId = opts?.cardId;
        if (cardId === undefined) {
          const inserted = this.store.db.prepare(`
            INSERT INTO kanban_board (title, source, source_id, priority, type, goal, labels, due_at, parent_id, notes, delivery_mode, blocked_by, chat_id, source_peer, max_agents, delivery_ready)
            VALUES (?, ?, NULL, ?, 'W', NULL, NULL, NULL, ?, ?, 'deliver', NULL, NULL, NULL, NULL, 1)
          `).run(
            opts?.title ?? rawGoal.slice(0, 80),
            opts?.source ?? "agent",
            opts?.priority ?? "MEDIUM",
            boundRootCardId,
            JSON.stringify({ supervised: true }),
          );
          cardId = Number(inserted.lastInsertRowid);
        } else {
          const existing = this.store.db.prepare(`SELECT parent_id, type FROM kanban_board WHERE id = ?`).get(cardId) as { parent_id: number | null; type: string | null } | undefined;
          if (!existing || existing.parent_id !== boundRootCardId || existing.type !== "W") {
            throw new Error(`project mutation rejected: child_card_mismatch`);
          }
        }

        this.store.insertContract(normalized.contract, cardId);
        const id = opts?.attemptId ?? createAttemptId();
        // #1638: the contract-derived intent owns routing — one resolver for
        // initial creation and retry, no capability/catalog reinterpretation.
        const intent = resolveWorkerExecutorIntent(normalized.contract);
        this.store.insertAttempt({
          id,
          card_id: cardId,
          contract_id: normalized.contract.id,
          ordinal: this.store.nextOrdinal(cardId),
          executor_kind: intent.kind,
          executor_id: intent.id,
          status: "pending",
          started_at: new Date().toISOString(),
          root_project_card_id: authority.projectCardId,
          root_project_generation: authority.projectGeneration,
          scheduled_run_id: authority.scheduledRunId ?? null,
        });
        return { attemptId: id, cardId };
      });
    } catch (err) {
      // #1644: a rejected project mutation (terminal root, generation/run
      // mismatch, missing authority) returns a typed error — the caller states
      // the project is terminal or the caller is stale and must stop.
      if (err instanceof Error && err.message.startsWith("project mutation rejected:")) {
        return { error: err.message };
      }
      throw err;
    }

    // #1644: the child card is committed with its contract and attempt in one
    // transaction; the queued wake fires only after commit so it always
    // observes a fully initialized child.
    if (opts?.cardId === undefined) {
      nerve.fire("card:queued", result.cardId);
    }

    return { contract: normalized.contract, attemptId: result.attemptId, cardId: result.cardId };
  }

  getContractForCard(cardId: number): WorkerAcceptanceContractV1 | undefined {
    const row = this.store.getLatestContractForCard(cardId);
    if (!row) return undefined;
    return JSON.parse(row.contract_json) as WorkerAcceptanceContractV1;
  }

  getContract(contractId: string): WorkerAcceptanceContractV1 | undefined {
    const row = this.store.getContract(contractId);
    if (!row) return undefined;
    return JSON.parse(row.contract_json) as WorkerAcceptanceContractV1;
  }

  getContractByRevision(cardId: number, revision: number): WorkerAcceptanceContractV1 | undefined {
    const row = this.store.db.prepare(`SELECT * FROM worker_contracts WHERE card_id = ? AND revision = ?`).get(cardId, revision) as ContractRow | undefined;
    if (!row) return undefined;
    return JSON.parse(row.contract_json) as WorkerAcceptanceContractV1;
  }

  cardHasContract(cardId: number): boolean {
    return this.store.contractExists(cardId);
  }

  renderContractForPrompt(contract: WorkerAcceptanceContractV1, retryContext?: RetryContext): string {
    const lines: string[] = [];

    lines.push(`<worker-contract id="${contract.id}" digest="${contract.digest}"${contract.revision_meta ? ` revision="${contract.revision_meta.revision}" root-contract-id="${contract.revision_meta.root_contract_id}"` : ""}>`);
    lines.push(`  <goal>${contract.goal}</goal>`);

    if (retryContext) {
      lines.push("  <retry-instructions>");
      lines.push(`    <mode>${retryContext.mode}</mode>`);
      lines.push(`    <instruction>${retryContext.instruction}</instruction>`);
      if (retryContext.do_not_repeat.length > 0) {
        lines.push("    <do-not-repeat>");
        for (const item of retryContext.do_not_repeat) {
          lines.push(`      <item>${item}</item>`);
        }
        lines.push("    </do-not-repeat>");
      }
      if (retryContext.failed_criterion_ids.length > 0) {
        lines.push("    <failed-criteria>");
        for (const fc of retryContext.failed_criterion_ids) {
          lines.push(`      <criterion id="${fc}"/>`);
        }
        lines.push("    </failed-criteria>");
      }
      if (retryContext.unresolved_risks.length > 0) {
        lines.push("    <unresolved-risks>");
        for (const risk of retryContext.unresolved_risks) {
          lines.push(`      <risk>${risk}</risk>`);
        }
        lines.push("    </unresolved-risks>");
      }
      lines.push("  </retry-instructions>");
    }

    if (contract.criteria.length > 0) {
      lines.push("  <criteria>");
      for (const c of contract.criteria) {
        lines.push(`    <criterion id="${c.id}">${c.description}</criterion>`);
      }
      lines.push("  </criteria>");
    }

    if (contract.expected_artifacts.length > 0) {
      lines.push("  <expected-artifacts>");
      for (const a of contract.expected_artifacts) {
        lines.push(`    <artifact id="${a.id}" kind="${a.kind}" required="${a.required}">${a.ref}</artifact>`);
      }
      lines.push("  </expected-artifacts>");
    }

    if (contract.verification_commands.length > 0) {
      lines.push("  <verification-commands>");
      for (const cmd of contract.verification_commands) {
        lines.push(`    <command id="${cmd.id}">${cmd.argv.join(" ")}</command>`);
      }
      lines.push("  </verification-commands>");
    }

    if (contract.required_capabilities.length > 0) {
      lines.push(`  <required-capabilities>${contract.required_capabilities.join(", ")}</required-capabilities>`);
    }

    if (contract.workspace_alias) {
      lines.push(`  <workspace>${contract.workspace_alias}</workspace>`);
    }

    lines.push("</worker-contract>");
    return lines.join("\n");
  }

  collectAndSettle(
    cardId: number,
    workerResult: string,
    workingDir: string | undefined,
    attemptId: string,
    generation: number,
    telemetryUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  ): { settled: boolean; summary: string; envelope?: WorkerResultEnvelopeV1; stale?: boolean; budgetViolation?: boolean } {
    // #1644: settlement identity is required. Missing attempt ID or expected
    // generation fails closed and never selects the latest attempt — the
    // generationless no-attempt path was removed.
    const attempts = this.store.getAttemptsForCard(cardId);
    const latestAttempt = attempts[attempts.length - 1];
    const targetAttempt = this.store.getAttempt(attemptId);
    if (!latestAttempt || !targetAttempt || targetAttempt.card_id !== cardId) {
      return { settled: false, summary: "stale execution result ignored", stale: true };
    }
    if (latestAttempt.id !== attemptId || targetAttempt.generation !== generation) {
      return { settled: false, summary: "stale execution result ignored", stale: true };
    }

    // Settled evidence must use the exact contract named by the attempt.
    const contract = this.getContract(targetAttempt.contract_id);
    if (!contract) return { settled: false, summary: workerResult.slice(0, MAX_RESULT_LENGTH) };

    // #1644: preflight project-authority check so a stale result for a
    // terminal root is rejected before verification commands run. The
    // authoritative gate is inside terminalSettlement's transaction.
    if (this.store.authorizeAttemptForProjectWork(targetAttempt, "worker_result_settlement") !== null) {
      return { settled: false, summary: "stale execution result ignored", stale: true };
    }

    const workerReport = this.parseWorkerReport(workerResult);
    const checks = this.runChecks(contract, workingDir);
    const artifacts = this.observeArtifacts(contract, workingDir);
    const criteria = this.deriveCriteria(contract, checks, artifacts);
    const allPassed = criteria.every(c => c.status === "passed");

    // Execution outcome is always "completed" when the Worker ran and checks
    // executed. Failed criteria mean unmet acceptance, not execution failure.
    const envelope: WorkerResultEnvelopeV1 = {
      schema_version: 1,
      attempt: {
        id: targetAttempt.id,
        ordinal: targetAttempt.ordinal,
        contract_id: contract.id,
        contract_digest: contract.digest,
        executor_kind: targetAttempt.executor_kind,
        executor_id: targetAttempt.executor_id,
        started_at: targetAttempt.started_at,
        finished_at: new Date().toISOString(),
      },
      outcome: "completed",
      criteria,
      checks,
      artifacts,
      worker_report: {
        summary: workerReport.summary.slice(0, MAX_RESULT_LENGTH),
        claims: workerReport.claims.slice(0, 30),
        unresolved_risks: workerReport.unresolved_risks.slice(0, 20),
      },
      ...(telemetryUsage ? {
        usage: {
          input_tokens: telemetryUsage.input,
          output_tokens: telemetryUsage.output,
          total_tokens: telemetryUsage.input + telemetryUsage.output,
        },
      } : {}),
    };

    const envelopeValidation = validateEnvelope(envelope);
    if (!envelopeValidation.ok) {
      const msg = `envelope validation failed: ${envelopeValidation.errors.map(e => e.message).join("; ")}`;
      logWarn(TAG, msg);
      throw new Error(msg);
    }

    const normalizedUsage = telemetryUsage
      ? { input: telemetryUsage.input, output: telemetryUsage.output, trustworthy: true }
      : undefined;
    const terminalInput = {
      attemptId: targetAttempt.id,
      expectedGeneration: targetAttempt.generation || 1,
      desiredState: "completed" as const,
      stableReason: "worker_completed",
      normalizedUsage,
      envelope,
    };
    const settlement = this.store.terminalSettlement(terminalInput);
    if (settlement.kind === "stale") {
      return { settled: false, summary: "stale execution result ignored", stale: true };
    }
    if (settlement.kind === "conflict") {
      return { settled: false, summary: "[conflict] duplicate attempt with different result" };
    }
    if (settlement.kind === "budget_violation") {
      return { settled: false, summary: "[budget_violation] worker exceeded its reserved token budget", stale: true, budgetViolation: true };
    }

    const summary = allPassed
      ? `✓ ${criteria.filter(c => c.status === "passed").length}/${criteria.length} criteria passed`
      : `✗ ${criteria.filter(c => c.status === "failed").length}/${criteria.length} criteria failed`;

    logSwarmTrace({ event: "worker_settled", card: cardId, attempt: targetAttempt.id, generation: targetAttempt.generation, to: "settled" });

    return { settled: true, summary, envelope };
  }

  private parseWorkerReport(result: string): { summary: string; claims: Array<{ criterion_id?: string; text: string }>; unresolved_risks: string[] } {
    const summary: string[] = [];
    const claims: Array<{ criterion_id?: string; text: string }> = [];
    const unresolved_risks: string[] = [];

    const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (summaryMatch) summary.push(summaryMatch[1]!.trim());

    const claimMatches = result.matchAll(/<claim(?:\s+criterion_id="([^"]*)")?>([\s\S]*?)<\/claim>/gi);
    for (const m of claimMatches) {
      claims.push({ criterion_id: m[1] || undefined, text: m[2]!.trim() });
    }

    const riskMatches = result.matchAll(/<risk>([\s\S]*?)<\/risk>/gi);
    for (const m of riskMatches) {
      unresolved_risks.push(m[1]!.trim());
    }

    if (summary.length === 0 && claims.length === 0 && unresolved_risks.length === 0) {
      const lines = result.split("\n").filter(l => l.trim()).slice(-3);
      summary.push(lines.join("; ").slice(0, MAX_RESULT_LENGTH));
    }

    return {
      summary: summary.join("\n"),
      claims,
      unresolved_risks,
    };
  }

  private runChecks(contract: WorkerAcceptanceContractV1, workingDir?: string): VerificationObservation[] {
    return contract.verification_commands.map(cmd => {
      const startedAt = new Date().toISOString();
      let exitCode: number | null = null;
      let signal: string | null = null;
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      try {
        const resolvedDir = cmd.cwd ? (workingDir ? resolve(workingDir, cmd.cwd) : cmd.cwd) : (workingDir ?? process.cwd());
        if (workingDir && !isWithinWorkspace(workingDir, resolvedDir)) {
          stderr = `rejected: cwd escapes workspace (${resolvedDir})`;
          return {
            check_id: cmd.id, argv: cmd.argv, cwd: cmd.cwd,
            started_at: startedAt, finished_at: new Date().toISOString(),
            timed_out: false, exit_code: null, signal: null,
            stdout_excerpt: "", stderr_excerpt: stderr.slice(0, MAX_CHECK_OUTPUT_LENGTH),
          };
        }
        const cwd = resolvedDir;
        const result = execFileSync(cmd.argv[0]!, cmd.argv.slice(1), {
          cwd,
          timeout: cmd.timeout_ms,
          maxBuffer: MAX_CHECK_OUTPUT_LENGTH,
          stdio: ["ignore", "pipe", "pipe"] as const,
        });
        exitCode = 0;
        stdout = result.stdout.toString("utf-8").slice(0, MAX_CHECK_OUTPUT_LENGTH);
        stderr = result.stderr.toString("utf-8").slice(0, MAX_CHECK_OUTPUT_LENGTH);
      } catch (err: unknown) {
        const e = err as ExecError;
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || e.code === "ETIMEDOUT") {
          timedOut = true;
        } else if (e.killed) {
          timedOut = true;
          signal = e.signal ?? null;
        } else {
          exitCode = e.status ?? null;
          signal = e.signal ?? null;
        }
        if (e.stdout) stdout = e.stdout.toString("utf-8").slice(0, MAX_CHECK_OUTPUT_LENGTH);
        if (e.stderr) stderr = e.stderr.toString("utf-8").slice(0, MAX_CHECK_OUTPUT_LENGTH);
      }

      const finishedAt = new Date().toISOString();

      return {
        check_id: cmd.id,
        argv: cmd.argv,
        cwd: cmd.cwd,
        started_at: startedAt,
        finished_at: finishedAt,
        timed_out: timedOut,
        exit_code: exitCode,
        signal,
        stdout_excerpt: stdout.slice(0, MAX_CHECK_OUTPUT_LENGTH),
        stderr_excerpt: stderr.slice(0, MAX_CHECK_OUTPUT_LENGTH),
      };
    });
  }

  private observeArtifacts(contract: WorkerAcceptanceContractV1, workingDir?: string): ArtifactObservation[] {
    return contract.expected_artifacts.map(a => {
      const ref = a.ref;
      const absPath = workingDir ? resolve(workingDir, ref) : ref;
      if (workingDir && !isWithinWorkspace(workingDir, absPath)) {
        return { artifact_id: a.id, exists: false, kind: a.kind, ref, error: "path escapes workspace" };
      }
      try {
        if (!existsSync(absPath)) {
          return { artifact_id: a.id, exists: false, kind: a.kind, ref, error: "not found" };
        }
        const st = statSync(absPath);
        const digest = a.kind === "file"
          ? createHash("sha256").update(readFileSync(absPath)).digest("hex").slice(0, 16)
          : undefined;
        return {
          artifact_id: a.id,
          exists: true,
          kind: a.kind,
          ref,
          size: st.size,
          digest: digest ? `sha256-${digest}` : undefined,
        };
      } catch (err) {
        return { artifact_id: a.id, exists: false, kind: a.kind, ref, error: String(err) };
      }
    });
  }

  private deriveCriteria(
    contract: WorkerAcceptanceContractV1,
    checks: VerificationObservation[],
    artifacts: ArtifactObservation[],
  ): Array<{ criterion_id: string; status: CriterionStatus; evidence_ids: string[] }> {
    return contract.criteria.map(c => {
      const evidenceIds: string[] = [];
      let status: CriterionStatus = "not_run";

      const relevantChecks = checks.filter(ch => {
        const cmd = contract.verification_commands.find(vc => vc.id === ch.check_id);
        return cmd?.criterion_ids.includes(c.id);
      });

      const requiredArtifacts = artifacts.filter(a => {
        const ea = contract.expected_artifacts.find(ea => ea.id === a.artifact_id);
        return ea?.criterion_ids.includes(c.id) && ea.required;
      });

      if (relevantChecks.length > 0) {
        evidenceIds.push(...relevantChecks.map(ch => ch.check_id));
        const allChecksPassed = relevantChecks.every(ch => ch.exit_code === 0 && !ch.timed_out);
        if (allChecksPassed) {
          status = "passed";
        } else {
          status = "failed";
        }
      }

      if (requiredArtifacts.length > 0) {
        evidenceIds.push(...requiredArtifacts.map(a => a.artifact_id));
        const allArtifactsExist = requiredArtifacts.every(a => a.exists);
        if (status === "not_run") {
          status = allArtifactsExist ? "passed" : "failed";
        } else if (!allArtifactsExist) {
          status = "failed";
        }
      }

      if (relevantChecks.length === 0 && requiredArtifacts.length === 0) {
        status = "inconclusive";
      }

      return { criterion_id: c.id, status, evidence_ids: evidenceIds };
    });
  }
}

/**
 * #1638: validate an alias against the enabled Pi configuration. The syntax
 * rule is bounded-identifier only; configuration presence is authoritative
 * for contract creation. A disabled/unconfigured Pi does NOT reject here —
 * the attempt is created as Pi and the generic dispatch path settles it as a
 * runtime eligibility failure, never as a silent Spin fallback. Only a
 * syntactically invalid alias or a known alias absent from a readable
 * configuration rejects contract creation.
 */
export function validateConfiguredWorkspaceAlias(alias: string): string[] {
  const errors: string[] = [];
  if (!isValidWorkspaceAlias(alias)) {
    errors.push(`invalid alias syntax "${alias}"`);
    return errors;
  }
  try {
    const config = loadPiConfig();
    if (!config) return errors; // disabled/unconfigured — runtime eligibility, dispatch settles it
    if (!(alias in config.workspaceAliases)) {
      errors.push(`unknown workspace alias "${alias}" — not in configured Pi workspace aliases`);
    }
  } catch (err) {
    errors.push(`Pi configuration unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return errors;
}

interface ExecError {
  code?: string | number;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  killed?: boolean;
  stdout?: Buffer;
  stderr?: Buffer;
}

function execFileSync(cmd: string, args: string[], opts: { cwd: string; timeout: number; maxBuffer: number; stdio: readonly ["ignore", "pipe", "pipe"] }): { stdout: Buffer; stderr: Buffer } {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
    stdio: opts.stdio as ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err: ExecError = {};
    err.code = result.status ?? undefined;
    err.status = result.status;
    err.signal = result.signal;
    err.stdout = result.stdout ?? undefined;
    err.stderr = result.stderr ?? undefined;
    throw err;
  }
  return { stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
}
