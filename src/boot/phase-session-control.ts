/**
 * phase-session-control.ts — boot composition of the session control service
 * (#1406).
 *
 * Registers the durable conversation adapter (abmind runtime + provider
 * summarizer) and the local Pi run adapter (PiRunService) once. The service
 * instance is exposed to command handlers through the module holder.
 */

import type { BootCtx, PhaseResult } from "./context.js";
import { logInfo, logWarn } from "../components/logger.js";
import { SessionControlService, DurableConversationCompactionAdapter, LocalPiRunCompactionAdapter } from "../components/session-control/index.js";
import { setSessionControlService } from "../components/session-control/instance.js";
import { createCompactionSummarizer } from "../components/compact-summarizer.js";
import { spin as spinInstance } from "../components/spin.js";
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

  // Durable conversation compaction needs the daemon-backed runtime plus the
  // provider summarizer. The adapter self-gates per call; registering it even
  // with a degraded runtime keeps the target resolvable.
  const summarizer = createCompactionSummarizer(spinInstance);
  service.register(new DurableConversationCompactionAdapter({
    runtime: ctx.memoryRuntime,
    summarizer,
  }));
  if (ctx.memoryRuntime.state === "ready") {
    logInfo(TAG, "Durable conversation compaction adapter registered");
  } else {
    // The runtime may recover after WSS renegotiation. Keep the target
    // registered so capability checks begin succeeding without a reboot.
    logWarn(TAG, `Durable compaction registered but unavailable (memory state: ${ctx.memoryRuntime.state})`);
  }

  // Locally supervised Pi-owned coding runs (native RPC compaction).
  if (ctx.piExecutorService) {
    service.register(new LocalPiRunCompactionAdapter({ piService: ctx.piExecutorService }));
    logInfo(TAG, "Local Pi run compaction adapter registered");
  }

  setSessionControlService(service);
  ctx.phaseHealth.set("phaseSessionControl", { status: "ok" });
  return "ran";
}
