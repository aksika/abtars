import { existsSync, statSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { normalizeContract, createContractId, createAttemptId, validateEnvelope } from "./worker-contract.js";
import { logWarn } from "./logger.js";
import { logSwarmTrace } from "./swarm-trace.js";
import type { WorkerAcceptanceContractV1, WorkerResultEnvelopeV1, CriterionStatus, VerificationObservation, ArtifactObservation, RetryContext } from "./worker-contract.js";
import type { TaskDatabase } from "./tasks/kanban-board.js";
import type { ContractRow } from "./worker-supervision-store.js";
import { ProjectReviewStore } from "./project-acceptance/project-review-store.js";
import { validateCriterionMapping } from "./project-acceptance/project-contract.js";

const TAG = "worker-supervision-service";
const MAX_RESULT_LENGTH = 500;
const MAX_CHECK_OUTPUT_LENGTH = 10_000;

/** Return a stable admission error when a child claims root criteria it cannot support. */
export function validateWorkerRootCriteria(
  rootCardId: number,
  childContractId: string,
  supportsRootCriteria: readonly string[],
): string | undefined {
  if (supportsRootCriteria.length === 0) return undefined;

  const reviewStore = new ProjectReviewStore();
  const rootContractRow = reviewStore.getContractByProjectCardId(rootCardId);
  if (!rootContractRow) {
    return `root contract not found for project ${rootCardId}; cannot validate criterion mapping`;
  }
  const rootContract = JSON.parse(rootContractRow.contract_json);
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
export function toWorkerExecutorKind(kind: string): "local_worker" | "remote_worker" {
  return kind === "remote" || kind === "remote_worker" ? "remote_worker" : "local_worker";
}

export class WorkerSupervisionService {
  private store: WorkerSupervisionStore;

  constructor(db?: TaskDatabase) {
    this.store = new WorkerSupervisionStore(db);
  }

  createChild(
    rawGoal: string,
    cardId: number,
    rootCardId: number,
    authoredBy: string,
    opts?: {
      criteria?: Array<{ id: string; description: string }>;
      expectedArtifacts?: Array<{ id: string; kind: "file" | "directory" | "report" | "logical"; ref: string; required: boolean; criterion_ids: string[] }>;
      verificationCommands?: Array<{ id: string; argv: string[]; cwd?: string; timeout_ms: number; criterion_ids: string[] }>;
      requiredCapabilities?: string[];
      supportsRootCriteria?: string[];
      limits?: { max_duration_ms?: number; max_tokens?: number };
      contractId?: string;
      attemptId?: string;
    },
  ): { contract: WorkerAcceptanceContractV1; attemptId: string } | { error: string } {
    if (this.store.contractExists(cardId)) {
      return { error: `card #${cardId} already has a contract` };
    }

    if (!opts?.criteria || opts.criteria.length === 0) {
      return { error: "supervised children require at least one acceptance criterion; goal-only supervised dispatch is rejected" };
    }

    if (opts?.supportsRootCriteria && opts.supportsRootCriteria.length > 0) {
      const mappingError = validateWorkerRootCriteria(rootCardId, opts.contractId ?? "(pending)", opts.supportsRootCriteria);
      if (mappingError) return { error: mappingError };
    }

    const contractId = opts?.contractId ?? createContractId();
    const raw: Record<string, unknown> = {
      schema_version: 1,
      id: contractId,
      goal: rawGoal,
      criteria: opts.criteria,
      provenance: {
        root_card_id: rootCardId,
        card_id: cardId,
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
    if (opts?.limits && Object.keys(opts.limits).length > 0) {
      raw["limits"] = opts.limits;
    }

    const normalized = normalizeContract(raw);
    if (!normalized.ok) {
      return { error: `contract validation failed: ${normalized.errors.map(e => e.message).join("; ")}` };
    }

    const attemptId = this.store.db.transaction(() => {
      this.store.insertContract(normalized.contract, cardId);
      const id = opts?.attemptId ?? createAttemptId();
      this.store.insertAttempt({
        id,
        card_id: cardId,
        contract_id: normalized.contract.id,
        ordinal: this.store.nextOrdinal(cardId),
        executor_kind: "local_worker",
        executor_id: "spin",
        status: "pending",
        started_at: new Date().toISOString(),
      });
      return id;
    });

    return { contract: normalized.contract, attemptId };
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

    lines.push("</worker-contract>");
    return lines.join("\n");
  }

  collectAndSettle(
    cardId: number,
    workerResult: string,
    workingDir?: string,
    attemptId?: string,
    generation?: number,
    telemetryUsage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  ): { settled: boolean; summary: string; envelope?: WorkerResultEnvelopeV1; stale?: boolean; budgetViolation?: boolean } {
    if (!attemptId && !this.getContractForCard(cardId)) {
      return { settled: false, summary: workerResult.slice(0, MAX_RESULT_LENGTH) };
    }
    const attempts = this.store.getAttemptsForCard(cardId);
    const latestAttempt = attempts[attempts.length - 1];
    let targetAttempt = attemptId ? this.store.getAttempt(attemptId) : latestAttempt;
    if (!latestAttempt || !targetAttempt || targetAttempt.card_id !== cardId) {
      return { settled: false, summary: "stale execution result ignored", stale: true };
    }
    if (attemptId && (latestAttempt.id !== attemptId || (generation !== undefined && targetAttempt.generation !== generation))) {
      return { settled: false, summary: "stale execution result ignored", stale: true };
    }

    // Settled evidence must use the exact contract named by the attempt. The
    // card's latest revision is only valid for the legacy no-attempt path.
    const contract = attemptId
      ? this.getContract(targetAttempt.contract_id)
      : this.getContractForCard(cardId);
    if (!contract) return { settled: false, summary: workerResult.slice(0, MAX_RESULT_LENGTH) };

    // Keep the legacy direct service API usable for callers that have not yet
    // been migrated to Reconciler-issued claims. Production supervised Spin
    // always supplies attemptId and therefore cannot bypass the claim path.
    if (!attemptId && targetAttempt.lifecycle === "pending") {
      const claim = this.store.claimAttempt(cardId, contract.id, "agent", "legacy-service", targetAttempt.generation || 1);
      if (!claim) return { settled: false, summary: "execution claim rejected", stale: true };
      targetAttempt = this.store.getAttempt(claim.attemptId);
      if (!targetAttempt || !this.store.markAttemptRunning(targetAttempt.id)) {
        return { settled: false, summary: "execution claim rejected", stale: true };
      }
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
        executor_kind: toWorkerExecutorKind(targetAttempt.executor_kind),
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
