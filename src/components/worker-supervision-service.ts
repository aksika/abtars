import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { WorkerSupervisionStore, settleResult, SettlementResult } from "./worker-supervision-store.js";
import { normalizeContract, createContractId, createAttemptId } from "./worker-contract.js";
import type { WorkerAcceptanceContractV1, WorkerResultEnvelopeV1, CriterionStatus, VerificationObservation, ArtifactObservation } from "./worker-contract.js";
import type { TaskDatabase } from "./tasks/kanban-board.js";
import { ExecutorProgressEmitter } from "./executor-progress-emitter.js";

const MAX_RESULT_LENGTH = 500;
const MAX_CHECK_OUTPUT_LENGTH = 10_000;

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

    const contractId = opts?.contractId ?? createContractId();
    const raw: Record<string, unknown> = {
      schema_version: 1,
      id: contractId,
      goal: rawGoal,
      criteria: opts?.criteria ?? [{ id: "c1", description: rawGoal }],
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

    this.store.insertContract(normalized.contract, cardId);

    const attemptId = opts?.attemptId ?? createAttemptId();
    this.store.insertAttempt({
      id: attemptId,
      card_id: cardId,
      contract_id: normalized.contract.id,
      ordinal: this.store.nextOrdinal(cardId),
      executor_kind: "local_worker",
      executor_id: "spin",
      status: "pending",
      started_at: new Date().toISOString(),
    });

    return { contract: normalized.contract, attemptId };
  }

  getContractForCard(cardId: number): WorkerAcceptanceContractV1 | undefined {
    const row = this.store.getContractByCardId(cardId);
    if (!row) return undefined;
    return JSON.parse(row.contract_json) as WorkerAcceptanceContractV1;
  }

  cardHasContract(cardId: number): boolean {
    return this.store.contractExists(cardId);
  }

  renderContractForPrompt(contract: WorkerAcceptanceContractV1): string {
    const lines: string[] = [];

    lines.push(`<worker-contract id="${contract.id}" digest="${contract.digest}">`);
    lines.push(`  <goal>${contract.goal}</goal>`);

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
  ): { settled: boolean; summary: string; envelope?: WorkerResultEnvelopeV1 } {
    const contract = this.getContractForCard(cardId);
    if (!contract) return { settled: false, summary: workerResult.slice(0, MAX_RESULT_LENGTH) };

    const attempts = this.store.getAttemptsForCard(cardId);
    const latestAttempt = attempts[attempts.length - 1];
    if (!latestAttempt) return { settled: false, summary: workerResult.slice(0, MAX_RESULT_LENGTH) };

    const workerReport = this.parseWorkerReport(workerResult);
    const checks = this.runChecks(contract, workingDir);
    const artifacts = this.observeArtifacts(contract, workingDir);
    const criteria = this.deriveCriteria(contract, checks, artifacts);
    const allPassed = criteria.every(c => c.status === "passed");
    const outcome = allPassed ? "completed" : "failed";

    const envelope: WorkerResultEnvelopeV1 = {
      schema_version: 1,
      attempt: {
        id: latestAttempt.id,
        ordinal: latestAttempt.ordinal,
        contract_id: contract.id,
        contract_digest: contract.digest,
        executor_kind: latestAttempt.executor_kind as "local_worker" | "remote_worker",
        executor_id: latestAttempt.executor_id,
        started_at: latestAttempt.started_at,
        finished_at: new Date().toISOString(),
      },
      outcome,
      criteria,
      checks,
      artifacts,
      worker_report: {
        summary: workerReport.summary.slice(0, MAX_RESULT_LENGTH),
        claims: workerReport.claims.slice(0, 30),
        unresolved_risks: workerReport.unresolved_risks.slice(0, 20),
      },
    };

    const result = settleResult(this.store, latestAttempt.id, envelope, outcome === "completed" ? "settled" : "failed");
    if (result === SettlementResult.Conflict) {
      return { settled: false, summary: "[conflict] duplicate attempt with different result" };
    }

    // #1367: Emit durable milestone progress on settlement
    try {
      const emitter = new ExecutorProgressEmitter();
      emitter.emitMilestone(latestAttempt.id, contract.provenance.card_id, latestAttempt.executor_id, contract.id, outcome === "completed" ? "all criteria passed" : "criteria failed");
    } catch { /* progress emission is best-effort */ }

    const summary = outcome === "completed"
      ? `✓ ${criteria.filter(c => c.status === "passed").length}/${criteria.length} criteria passed`
      : `✗ ${criteria.filter(c => c.status === "failed").length}/${criteria.length} criteria failed`;

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
        const cwd = cmd.cwd ? (workingDir ? resolve(workingDir, cmd.cwd) : cmd.cwd) : (workingDir ?? process.cwd());
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
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
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
      try {
        if (!existsSync(absPath)) {
          return { artifact_id: a.id, exists: false, kind: a.kind, ref, error: "not found" };
        }
        const st = statSync(absPath);
        const digest = a.kind === "file"
          ? createHash("sha256").update(absPath).digest("hex").slice(0, 16)
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
