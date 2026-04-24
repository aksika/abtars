/**
 * compaction-guard.ts — Post-response context window management.
 * Graduated thresholds: warn → compact → aggressive compact.
 * Circuit breaker after repeated failures.
 */

import { logInfo, logDebug, logError } from "../logger.js";
import { writeRestartReason } from "../transport/bridge-lock-transport.js";
import { runCompaction } from "../compaction.js";
import { getEnv } from "../env-schema.js";
import type { SessionRegistry } from "../session-registry.js";
import type { IKiroTransport } from "../transport/kiro-transport.js";
import type { PlatformAdapter, InboundMessage } from "../../types/platform.js";
import type { MemoryManager } from "abmind/memory-manager.js";

const TAG = "pipeline";
const COMPACT_MAX_FAILURES = 3;

export interface CompactionGuardDeps {
  transport: IKiroTransport;
  sessions: SessionRegistry;
  memory: MemoryManager | null;
  memoryConfig: { memoryEnabled: boolean; memoryDir: string };
  updateCtxStart: (memoryDir: string, userId: string) => void;
}

export async function runCompactionGuard(
  msg: InboundMessage,
  adapter: PlatformAdapter,
  deps: CompactionGuardDeps,
): Promise<void> {
  const { transport, sessions, memory, memoryConfig, updateCtxStart } = deps;
  const { sessionKey, channelId } = msg;
  const userId = sessionKey.includes(":") ? sessionKey.split(":")[0]! : "master";
  const pct = transport.contextPercent;
  if (pct < 0) return;

  const failures = sessions.getOrCreate(sessionKey).compactFailures;

  if (pct >= getEnv().ctxCompactPct && failures < COMPACT_MAX_FAILURES) {
    const aggressive = pct >= getEnv().ctxAggressivePct;
    logInfo(TAG, `📦 Context at ${pct}% (${aggressive ? "aggressive" : "compact"} threshold) — compacting`);
    writeRestartReason(`compaction: ctx at ${pct}%`);
    await adapter.sendMessage(channelId, `📦 Context at ${pct}% — compacting...`, { threadId: msg.threadId });

    try {
      if (memory) {
        memory.maintenance.checkAutoCompact({
          userId, sessionId: sessionKey, contextPercent: pct,
          sendCompactCommand: async () => "",
        }).catch(() => {});
      }

      await runCompaction(transport, sessionKey, sessions);
      { const e = sessions.getOrCreate(sessionKey); e.ctxWarned = false; e.compactFailures = 0; }

      await adapter.sendMessage(channelId, "📦 Compaction complete.", { threadId: msg.threadId });
      if (memoryConfig.memoryEnabled) updateCtxStart(memoryConfig.memoryDir, userId);
    } catch (err) {
      const entry = sessions.getOrCreate(sessionKey);
      entry.compactFailures++;
      logError(TAG, `Compaction failed (${entry.compactFailures}/${COMPACT_MAX_FAILURES})`, err);
      if (entry.compactFailures >= COMPACT_MAX_FAILURES) {
        await adapter.sendMessage(channelId, "⚠️ Compaction failing repeatedly — consider /reset", { threadId: msg.threadId });
      }
    }
  } else if (pct >= getEnv().ctxWarnPct && !sessions.getOrCreate(sessionKey).ctxWarned) {
    sessions.getOrCreate(sessionKey).ctxWarned = true;
    logInfo(TAG, `⚠️ Context at ${pct}% — warning threshold`);
    await adapter.sendMessage(channelId, `⚠️ Context window at ${pct}% — will auto-compact at ${getEnv().ctxCompactPct}%`, { threadId: msg.threadId });
  } else if (pct >= getEnv().ctxCompactPct && failures >= COMPACT_MAX_FAILURES) {
    logDebug(TAG, `Context at ${pct}% but compaction circuit breaker active (${failures} failures)`);
  }
}
