/**
 * worker-executor-routing.ts — #1638: the single mechanical executor resolver.
 *
 * `workspace_alias` present -> Pi; absent -> Spin. There is no natural-language
 * classifier, capability-string parser, or Pi-to-Spin fallback anywhere.
 * Initial creation, automatic retry, and Orc-directed retry all resolve through
 * this one function; a preference cannot move an alias contract to Spin or a
 * no-alias contract to Pi.
 */
import { AGENT_EXECUTOR_ID, PI_EXECUTOR_ID, type ExecutorKind } from "./worker-executor-identity.js";
import type { WorkerAcceptanceContractV1 } from "./worker-contract.js";

export type WorkerExecutorIntent =
  | { kind: "agent"; id: "spin-local"; workspaceAlias?: undefined }
  | { kind: "pi"; id: "pi-coding"; workspaceAlias: string };

export function resolveWorkerExecutorIntent(contract: WorkerAcceptanceContractV1): WorkerExecutorIntent {
  if (contract.workspace_alias !== undefined && contract.workspace_alias.length > 0) {
    return { kind: "pi", id: PI_EXECUTOR_ID, workspaceAlias: contract.workspace_alias };
  }
  return { kind: "agent", id: AGENT_EXECUTOR_ID };
}

export function intentToAttemptPair(intent: WorkerExecutorIntent): { executorKind: ExecutorKind; executorId: string } {
  return { executorKind: intent.kind, executorId: intent.id };
}
