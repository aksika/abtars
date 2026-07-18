import type { ManagedSession } from "../../components/spin-types.js";
import type { RuntimeStatusSnapshot, RuntimeUsageSnapshot } from "../../components/transport/kiro-transport.js";

export interface TuiUsageSnapshot extends RuntimeUsageSnapshot {
  cacheHitPercent?: number;
}

export interface TuiRuntimeStatus {
  sessionId: string;
  revision: number;
  cwd?: string;
  provider?: string;
  model?: string;
  contextPercent?: number;
  contextWindow?: number;
  autoCompaction?: boolean;
  reasoning?: RuntimeStatusSnapshot["reasoning"];
  lastTurnUsage?: TuiUsageSnapshot;
  sessionUsage?: TuiUsageSnapshot;
}

function withCacheHit(usage?: RuntimeUsageSnapshot): TuiUsageSnapshot | undefined {
  if (!usage) return undefined;
  const result: TuiUsageSnapshot = { ...usage };
  if (usage.input > 0 && usage.cacheRead !== undefined) {
    result.cacheHitPercent = (usage.cacheRead / usage.input) * 100;
  }
  return result;
}

/** Build an allowlisted, secret-free status projection for the TUI. */
export function buildTuiRuntimeStatus(session: ManagedSession, revision: number): TuiRuntimeStatus {
  const transport = session.transport;
  const transportStatus = transport?.getRuntimeStatus?.() ?? {};
  return {
    sessionId: session.id,
    revision,
    cwd: session.workingDir,
    provider: session.provider ?? transportStatus.provider,
    model: transportStatus.model ?? session.model,
    contextPercent: transportStatus.contextPercent ?? session.contextPercent,
    contextWindow: transportStatus.contextWindow,
    autoCompaction: transportStatus.autoCompaction,
    reasoning: transportStatus.reasoning,
    lastTurnUsage: withCacheHit(transportStatus.lastTurnUsage ?? session.lastTurnUsage),
    sessionUsage: withCacheHit(session.sessionUsage),
  };
}
