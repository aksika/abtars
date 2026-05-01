/**
 * compaction-guard.ts — Post-response context window management.
 * With #319 context engine, compaction is handled inside buildContext() and
 * via onApiResponse() reactive feedback. This guard is now a no-op for
 * DirectApiTransport sessions with contextOrchestrator attached.
 * Kept as a shell for backward compat with ACP transport (which still uses old path).
 */

import { logDebug } from "../logger.js";
import type { SessionRegistry } from "../session-registry.js";
import type { IKiroTransport } from "../transport/kiro-transport.js";
import type { PlatformAdapter, InboundMessage } from "../../types/platform.js";
import type { MemoryManager } from "abmind";

const TAG = "pipeline";

export interface CompactionGuardDeps {
  transport: IKiroTransport;
  sessions: SessionRegistry;
  memory: MemoryManager | null;
  memoryConfig: { memoryEnabled: boolean; memoryDir: string };
  updateCtxStart: (memoryDir: string, userId: string) => void;
}

export async function runCompactionGuard(
  _msg: InboundMessage,
  _adapter: PlatformAdapter,
  deps: CompactionGuardDeps,
): Promise<void> {
  const { transport } = deps;
  const pct = transport.contextPercent;
  if (pct < 0) return;

  // Context engine handles compaction automatically via buildContext() + onApiResponse().
  // This guard only logs for debugging.
  if (pct > 50) {
    logDebug(TAG, `Context at ${pct}% — context engine manages compaction automatically`);
  }
}
