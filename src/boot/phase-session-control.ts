/**
 * phase-session-control.ts — boot composition of the session control service
 * (#1406).
 *
 * Registers the local Pi run adapter (PiRunService) for natively supervised
 * coding runs. abmind conversation compaction is retired (#1940 R8): Pi owns
 * compaction on the Pi route and the system prompt survives it, so no
 * durable adapter, summarizer, post-compaction rehydration, or bundle
 * refresh is wired.
 */

import type { BootCtx, PhaseResult } from "./context.js";
import { logInfo } from "../components/logger.js";
import { SessionControlService, LocalPiRunCompactionAdapter } from "../components/session-control/index.js";
import { setSessionControlService } from "../components/session-control/instance.js";
import { recordCompaction } from "../components/metrics-collector.js";

const TAG = "boot-session-control";

export async function phaseSessionControl(ctx: BootCtx): Promise<PhaseResult> {
  const service = new SessionControlService({
    onTelemetry: (event) => {
      // #1406: feed the metrics.jsonl audit trail + latency/savings rings.
      // Only a real failure counts as failed; busy/stale/unsupported are
      // skipped (no work was done), nothing_to_compact is a clean no-op.
      recordCompaction({
        level: event.status === "completed" ? "completed"
          : event.status === "failed" ? "failed"
          : "skipped",
        durationMs: event.durationMs,
        savingsPct: event.savingsPct,
        provider: event.provider,
        model: event.model,
        failureReason: event.status === "failed" ? "control_failed" : undefined,
      });
    },
  });

  // Locally supervised Pi-owned coding runs (native RPC compaction).
  if (ctx.piExecutorService) {
    service.register(new LocalPiRunCompactionAdapter({ piService: ctx.piExecutorService }));
    logInfo(TAG, "Local Pi run compaction adapter registered");
  }

  setSessionControlService(service);
  ctx.phaseHealth.set("phaseSessionControl", { status: "ok" });
  return "ran";
}
