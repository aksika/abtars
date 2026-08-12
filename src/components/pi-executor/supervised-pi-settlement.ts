/**
 * supervised-pi-settlement.ts — #1638: the single terminal router for every
 * Pi process observation.
 *
 * The router looks up the exact (run_id, pi_generation) Worker binding. No
 * binding means standalone and calls the existing PiRunStore.settleTerminal()
 * behavior. A binding means supervised and invokes settleSupervisedPiExecution(),
 * which owns the Worker-attempt terminal settlement via the canonical
 * WorkerSupervisionStore.settleAttemptInTransaction body.
 *
 * Supervised settlement NEVER transitions the W card from the Pi lane and
 * NEVER calls the standalone PiRunStore.settleTerminal() (which owns the
 * Pi-card transition).
 */
import type { PiRunStore, PiTerminalMetadata, PiTerminalOutcome } from "./pi-run-store.js";
import type { WorkerSupervisionStore } from "../worker-supervision-store.js";
import type { WorkerResultEnvelopeV1 } from "../worker-contract.js";
import { logWarn } from "../logger.js";
import { validateSessionFile, resolveAndValidateWorkspace, type PiExecutorConfig } from "./config.js";

const TAG = "supervised-pi-settlement";

export interface PiTerminalObservation {
  runId: string;
  generation: number;
  outcome: PiTerminalOutcome;
  metadata: PiTerminalMetadata;
  /** #1638: supplied structured Worker envelope (e.g. an input_requested
   * question) — persisted for non-completed outcomes by the canonical body. */
  envelope?: WorkerResultEnvelopeV1;
  /** Canonical workspace path, released after commit by the coordinator. */
  canonicalPath?: string;
}

export type PiSettlementObservation =
  | { kind: "settled"; cardId: number; supervised: boolean; outcome: PiTerminalOutcome }
  | { kind: "replayed" }
  | { kind: "stale"; reason: string }
  | { kind: "conflict"; reason: string }
  | { kind: "error"; message: string };

export class SupervisedPiSettlement {
  constructor(
    private readonly piStore: PiRunStore,
    private readonly workerStore: WorkerSupervisionStore,
    private readonly piConfig: PiExecutorConfig,
  ) {}

  /** Route one terminal Pi observation: supervised iff a Worker binding exists. */
  settlePiExecution(input: PiTerminalObservation): PiSettlementObservation {
    const run = this.piStore.get(input.runId);
    const binding = this.workerStore.getAttemptForExecutorResource("pi", input.runId, input.generation);
    if (!binding) {
      // A supervised run must never fall back to the standalone Pi-card
      // settlement path if its binding is temporarily missing (for example
      // during crash recovery). Failing closed preserves Worker ownership.
      if (run?.origin === "supervised") {
        return { kind: "stale", reason: "supervised run has no Worker binding" };
      }
      // #1638: no Worker binding — standalone lane keeps its own settlement.
      const result = this.piStore.settleTerminal({
        runId: input.runId,
        generation: input.generation,
        expectedStatuses: ["starting", "running", "awaiting_input", "interrupted"],
        outcome: input.outcome,
        metadata: input.metadata,
      });
      if (result.committed) return { kind: "settled", cardId: result.cardId, supervised: false, outcome: input.outcome };
      return result.committed === false && "reason" in result
        ? { kind: "stale", reason: String((result as { reason?: string }).reason ?? "unknown") }
        : { kind: "conflict", reason: "standalone settlement failed" };
    }
    // #1638: resolve the canonical workspace from the run itself so the
    // generation-fenced release always runs — callers never need to supply it.
    let canonicalPath: string | undefined = input.canonicalPath;
    if (!canonicalPath) {
      if (run) {
        const ws = resolveAndValidateWorkspace(run.workspaceAlias, this.piConfig);
        if (!ws.error) canonicalPath = ws.canonicalPath;
      }
    }
    return this.settleSupervisedPiExecution(binding.card_id, binding.generation, binding.contract_id, { ...input, canonicalPath });
  }

  private settleSupervisedPiExecution(
    attemptCardId: number,
    attemptGeneration: number,
    contractId: string,
    input: PiTerminalObservation,
  ): PiSettlementObservation {    try {
      return this.workerStore.db.transaction(() => {
        // Re-read + validate the latest attempt inside the transaction.
        const attempt = this.workerStore.getAttemptForExecutorResource("pi", input.runId, input.generation);
        if (!attempt) return { kind: "stale", reason: "binding lost" };
        if (attempt.card_id !== attemptCardId || attempt.generation !== attemptGeneration) {
          return { kind: "stale", reason: "attempt generation moved on" };
        }
        const latest = this.workerStore.getLatestAttempt(attempt.card_id);
        if (!latest || latest.id !== attempt.id) return { kind: "stale", reason: "not latest attempt" };
        if (attempt.contract_id !== contractId) return { kind: "stale", reason: "binding contract moved on" };

        // Replay: the attempt already terminal means this exact observation
        // was settled before — return the replay result without re-touching
        // the run row or the attempt.
        if (this.workerStore.isAttemptTerminal(attempt.lifecycle)) {
          return { kind: "replayed" };
        }

        const contract = this.workerStore.getContract(attempt.contract_id);
        if (!contract) return { kind: "stale", reason: "contract missing" };

        // Pi run terminal transition — run row only, never the W card.
        const runResult = this.piStore.settleSupervisedRunInTransaction({
          runId: input.runId,
          generation: input.generation,
          expectedStatuses: ["starting", "running", "awaiting_input", "interrupted"],
          outcome: input.outcome,
          metadata: input.metadata,
        });
        if (!runResult.committed) return { kind: "stale", reason: String(runResult.reason ?? "run transition failed") };

        // Canonical Worker terminal settlement — one body, in this transaction.
        const desiredState = input.outcome === "completed" ? "completed"
          : input.outcome === "failed" ? "failed" : "cancelled";
        // #1638: a completed supervised Pi run always carries a Worker
        // envelope with Pi provenance — the canonical body only persists a
        // supplied envelope for completed outcomes.
        const completedEnvelope: WorkerResultEnvelopeV1 | undefined = input.outcome === "completed"
          ? {
              schema_version: 1,
              attempt: {
                id: attempt.id,
                ordinal: attempt.ordinal,
                contract_id: attempt.contract_id,
                contract_digest: contract.contract_digest,
                executor_kind: "pi",
                executor_id: attempt.executor_id,
                started_at: attempt.started_at,
                finished_at: new Date().toISOString(),
              },
              outcome: "completed",
              criteria: [],
              checks: [],
              artifacts: [],
              worker_report: {
                summary: (input.metadata.resultSummary ?? "Pi execution completed").slice(0, 500),
                claims: [],
                unresolved_risks: [],
              },
            }
          : undefined;
        const settlement = this.workerStore.settleAttemptInTransaction({
          attemptId: attempt.id,
          expectedGeneration: attempt.generation,
          desiredState,
          stableReason: `pi_${input.outcome}`,
          envelope: input.envelope ?? completedEnvelope,
        });
        if (settlement.kind === "stale" || settlement.kind === "conflict") {
          return { kind: "conflict", reason: `worker settlement ${settlement.kind}` };
        }

        // Release the workspace claim (generation-fenced) inside the same
        // transaction when a canonical path was supplied.
        if (input.canonicalPath) {
          this.piStore.releaseWorkspaceClaim({
            canonicalPath: input.canonicalPath,
            runId: input.runId,
            generation: input.generation,
          });
        } else {
          this.piStore.releaseWorkspaceClaimForGeneration({ runId: input.runId, generation: input.generation });
        }

        return { kind: "settled", cardId: attempt.card_id, supervised: true, outcome: input.outcome };
      });
    } catch (err) {
      logWarn(TAG, `supervised settlement failed for ${input.runId}: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: "error", message: String(err) };
    }
  }

  /**
   * #1638 — supervised input suspension. A live Pi question on a supervised
   * run never parks the process in awaiting_input: the question becomes
   * structured Worker failure evidence (input_requested), the run moves to
   * resumable interrupted, the workspace claim is released, and the attempt
   * settles through the canonical body with zero charge. Orc's answer on a
   * retry resumes the preserved session when durable.
   */
  suspendForInput(input: {
    runId: string;
    generation: number;
    question: string;
    requestId: string;
    sessionFile?: string;
  }): { suspended: boolean; reason?: string } {
    const attempt = this.workerStore.getAttemptForExecutorResource("pi", input.runId, input.generation);
    if (!attempt) return { suspended: false, reason: "not supervised" };
    const run = this.piStore.get(input.runId);
    if (!run) return { suspended: false, reason: "run missing" };

    // Prove the session file is durable AND inside the configured session
    // root BEFORE stopping the process. No proof -> the next generation must
    // be fresh; the question still settles as input_requested.
    let resumeAvailable = false;
    let sessionFile = input.sessionFile;
    if (sessionFile) {
      const validated = validateSessionFile(this.piConfig.sessionStorageRoot, sessionFile);
      resumeAvailable = validated.error === undefined;
      if (validated.error) {
        sessionFile = undefined;
        logWarn(TAG, `input suspend ${input.runId}: session not durable (${validated.error}) — next generation will be fresh`);
      } else {
        // Persist the proven canonical path, not a caller-provided spelling or
        // symlink, so the next generation resumes exactly the file we checked.
        sessionFile = validated.canonicalPath;
      }
    }

    // Canonical workspace path for the generation-fenced release.
    const ws = resolveAndValidateWorkspace(run.workspaceAlias, this.piConfig);
    const canonicalPath = ws.error ? undefined : ws.canonicalPath;

    try {
      return this.workerStore.db.transaction(() => {
        const latest = this.workerStore.getLatestAttempt(attempt.card_id);
        if (!latest || latest.id !== attempt.id) return { suspended: false, reason: "stale attempt" };
        const contract = this.workerStore.getContract(attempt.contract_id);
        if (!contract) return { suspended: false, reason: "contract missing" };

        // run -> interrupted (resumable when the session is durable)
        const interrupted = this.piStore.casTransition(input.runId, ["running", "awaiting_input", "starting"], "interrupted", {
          pendingRequestId: null,
          pendingRequestType: null,
          piSessionFile: sessionFile ?? undefined,
          resumeCapability: resumeAvailable ? "available" : "never_started",
        });
        if (!interrupted) return { suspended: false, reason: "run transition lost" };

        // canonical Worker settlement with the structured question envelope
        const envelope: WorkerResultEnvelopeV1 = {
          schema_version: 1,
          attempt: {
            id: attempt.id,
            ordinal: attempt.ordinal,
            contract_id: attempt.contract_id,
            contract_digest: contract.contract_digest,
            executor_kind: "pi",
            executor_id: attempt.executor_id,
            started_at: attempt.started_at,
            finished_at: new Date().toISOString(),
          },
          outcome: "failed",
          criteria: [],
          checks: [],
          artifacts: [],
          worker_report: {
            summary: `Pi asked for input: ${input.question.slice(0, 500)}`,
            claims: [],
            unresolved_risks: [],
          },
          error: {
            code: "INPUT_REQUESTED",
            message: input.question.slice(0, 2000),
            retryable: true,
          },
        };
        const settlement = this.workerStore.settleAttemptInTransaction({
          attemptId: attempt.id,
          expectedGeneration: attempt.generation,
          desiredState: "failed",
          stableReason: `pi_input_requested:${input.requestId.slice(0, 40)}`,
          envelope,
          terminalCause: "input_requested",
        });
        if (settlement.kind === "stale" || settlement.kind === "conflict") {
          return { suspended: false, reason: `settlement ${settlement.kind}` };
        }

        if (canonicalPath) {
          this.piStore.releaseWorkspaceClaim({
            canonicalPath,
            runId: input.runId,
            generation: input.generation,
          });
        } else {
          this.piStore.releaseWorkspaceClaimForGeneration({ runId: input.runId, generation: input.generation });
        }

        return { suspended: true };
      });
    } catch (err) {
      logWarn(TAG, `input suspension failed for ${input.runId}: ${err instanceof Error ? err.message : String(err)}`);
      return { suspended: false, reason: String(err) };
    }
  }
}
