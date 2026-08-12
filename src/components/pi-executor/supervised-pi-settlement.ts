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
  ) {}

  /** Route one terminal Pi observation: supervised iff a Worker binding exists. */
  settlePiExecution(input: PiTerminalObservation): PiSettlementObservation {
    const binding = this.workerStore.getAttemptForExecutorResource("pi", input.runId, input.generation);
    if (!binding) {
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
    return this.settleSupervisedPiExecution(binding.card_id, binding.generation, binding.contract_id, input);
  }

  private settleSupervisedPiExecution(
    attemptCardId: number,
    attemptGeneration: number,
    contractId: string,
    input: PiTerminalObservation,
  ): PiSettlementObservation {
    try {
      return this.workerStore.db.transaction(() => {
        // Re-read + validate the latest attempt inside the transaction.
        const attempt = this.workerStore.getAttemptForExecutorResource("pi", input.runId, input.generation);
        if (!attempt) return { kind: "stale", reason: "binding lost" };
        if (attempt.card_id !== attemptCardId || attempt.generation !== attemptGeneration) {
          return { kind: "stale", reason: "attempt generation moved on" };
        }
        const latest = this.workerStore.getLatestAttempt(attempt.card_id);
        if (!latest || latest.id !== attempt.id) return { kind: "stale", reason: "not latest attempt" };
        void contractId;

        // Replay: the attempt already terminal means this exact observation
        // was settled before — return the replay result without re-touching
        // the run row or the attempt.
        if (this.workerStore.isAttemptTerminal(attempt.lifecycle)) {
          return { kind: "replayed" };
        }

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
        const settlement = this.workerStore.settleAttemptInTransaction({
          attemptId: attempt.id,
          expectedGeneration: attempt.generation,
          desiredState,
          stableReason: `pi_${input.outcome}`,
          envelope: input.envelope,
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
        }

        return { kind: "settled", cardId: attempt.card_id, supervised: true, outcome: input.outcome };
      });
    } catch (err) {
      logWarn(TAG, `supervised settlement failed for ${input.runId}: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: "error", message: String(err) };
    }
  }
}
