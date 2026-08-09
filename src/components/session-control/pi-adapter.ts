/**
 * session-control/pi-adapter.ts — locally supervised Pi-owned coding run
 * compaction (#1406).
 *
 * Delegates to PiRunService, which verifies ownership, generation, live
 * process identity, and state before invoking the official native RPC
 * `compact` operation. The raw RPC client never leaves the executor.
 */

import type { PiRunService } from "../pi-executor/pi-run-service.js";
import type {
  SessionControlAdapter, SessionControlRequest, SessionControlResult,
} from "./types.js";

export interface LocalPiRunAdapterDeps {
  piService: PiRunService;
}

export class LocalPiRunCompactionAdapter
  implements SessionControlAdapter<{ kind: "local_pi_run"; principalId: string; runId: string; generation: number }> {
  readonly targetKind = "local_pi_run" as const;
  private readonly deps: LocalPiRunAdapterDeps;

  constructor(deps: LocalPiRunAdapterDeps) {
    this.deps = deps;
  }

  supports(request: SessionControlRequest): boolean {
    return request.kind === "compact";
  }

  async execute(
    target: { kind: "local_pi_run"; principalId: string; runId: string; generation: number },
    request: SessionControlRequest,
  ): Promise<SessionControlResult> {
    if (request.kind !== "compact") {
      return {
        status: "unsupported",
        targetKind: "local_pi_run",
        message: `Operation not supported: ${request.kind}`,
      };
    }
    return this.deps.piService.compact(target.runId, request.customInstructions, {
      userId: target.principalId,
    }, target.generation);
  }
}
