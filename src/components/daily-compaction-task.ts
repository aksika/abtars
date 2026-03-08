import type Database from "better-sqlite3";
import type { HeartbeatTask } from "../types/memory.js";
import type { MemoryConfig } from "./memory-config.js";
import type { TranscriptParser } from "./transcript-parser.js";
import type { MemoryIndex } from "./memory-index.js";
import { CompactionEngine } from "./compaction-engine.js";
import { logDebug, logError, logInfo } from "./logger.js";

const TAG = "daily-compaction";

/**
 * Daily compaction task — automatic day-boundary compaction for the heartbeat loop.
 *
 * This module exports:
 * - isEligibleForCompaction (pure eligibility check)
 * - getUncompactedSessions (DB query)
 * - createDailyCompactionTask (heartbeat task factory)
 * - runStartupCatchUp (startup catch-up runner)
 */

export type DailyCompactionDeps = {
  db: Database.Database;
  config: MemoryConfig;
  transcriptParser: TranscriptParser;
  memoryIndex: MemoryIndex;
  getLlmCall: () => ((prompt: string, content: string) => Promise<string>) | null;
  acquireLock: (chatId: number) => Promise<() => void> | null;
};

/**
 * Pure eligibility check: determines whether a chat session should be compacted
 * based on the last message timestamp, current time, and configured inactivity gap.
 *
 * Returns `true` only when:
 * 1. The current time is on a strictly later calendar day than the last message, AND
 * 2. The elapsed time since the last message exceeds `dayBoundaryHours` hours.
 */
export function isEligibleForCompaction(params: {
  lastMessageTimestamp: number; // ms epoch
  now: number; // ms epoch
  dayBoundaryHours: number; // e.g. 4
}): boolean {
  const { lastMessageTimestamp, now, dayBoundaryHours } = params;
  const gapMs = dayBoundaryHours * 3_600_000;

  // Condition 1: now must be on a strictly later calendar day than lastMessageTimestamp
  const lastMsgDate = new Date(lastMessageTimestamp);
  const nowDate = new Date(now);

  const lastDay = new Date(lastMsgDate.getFullYear(), lastMsgDate.getMonth(), lastMsgDate.getDate());
  const today = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  if (lastDay.getTime() >= today.getTime()) return false; // same day — not past midnight boundary

  // Condition 2: inactivity gap must have elapsed since last message
  if (now - lastMessageTimestamp < gapMs) return false;

  return true;
}

/**
 * Query sessions for a given chat that have messages newer than their latest daily compaction.
 * Returns each session's ID, the timestamp of its most recent message, and the
 * watermark (latest compaction timestamp) so callers can filter to only new messages.
 */
export function getUncompactedSessions(
  db: Database.Database,
  chatId: number,
): Array<{ sessionId: string; lastMessageTimestamp: number; sinceTimestamp: number }> {
  const rows = db
    .prepare(
      `SELECT m.session_id,
              MAX(m.timestamp) as last_message_ts,
              COALESCE(
                (SELECT MAX(c.timestamp) FROM compactions c
                 WHERE c.chat_id = ? AND c.source_session_id = m.session_id AND c.tier = 'daily'),
                0
              ) as watermark
       FROM messages m
       WHERE m.chat_id = ?
       GROUP BY m.session_id
       HAVING MAX(m.timestamp) > watermark`,
    )
    .all(chatId, chatId) as Array<{ session_id: string; last_message_ts: number; watermark: number }>;

  return rows.map((row) => ({
    sessionId: row.session_id,
    lastMessageTimestamp: row.last_message_ts,
    sinceTimestamp: row.watermark,
  }));
}

/**
 * Get the earliest message timestamp for a session after a given watermark,
 * used to derive the compaction date for the new batch of messages.
 */
function getEarliestMessageDate(db: Database.Database, chatId: number, sessionId: string, sinceTimestamp: number = 0): Date {
  const row = db
    .prepare("SELECT MIN(timestamp) as earliest_ts FROM messages WHERE chat_id = ? AND session_id = ? AND timestamp > ?")
    .get(chatId, sessionId, sinceTimestamp) as { earliest_ts: number } | undefined;
  return row?.earliest_ts ? new Date(row.earliest_ts) : new Date();
}

/**
 * Factory: creates the heartbeat task for daily compaction.
 *
 * The task iterates active chats, finds uncompacted sessions, checks eligibility
 * via the inactivity-gap day boundary, and invokes CompactionEngine.compact()
 * for each eligible session. Errors per session are logged and do not halt
 * processing of remaining sessions.
 */
export function createDailyCompactionTask(deps: DailyCompactionDeps): HeartbeatTask {
  return {
    name: "daily-compaction",
    async execute() {
      const llmCall = deps.getLlmCall();
      if (!llmCall) {
        logDebug(TAG, "LLM call unavailable — skipping daily compaction");
        return;
      }

      // Get all active chats
      const chats = deps.db
        .prepare("SELECT DISTINCT chat_id FROM messages")
        .all() as Array<{ chat_id: number }>;

      for (const chat of chats) {
        const chatId = chat.chat_id;
        const lock = deps.acquireLock(chatId);
        if (!lock) {
          logDebug(TAG, `Chat ${chatId} already being compacted — skipping`);
          continue;
        }

        const release = await lock;
        try {
          const sessions = getUncompactedSessions(deps.db, chatId);
          const now = Date.now();

          for (const session of sessions) {
            if (
              !isEligibleForCompaction({
                lastMessageTimestamp: session.lastMessageTimestamp,
                now,
                dayBoundaryHours: deps.config.dayBoundaryHours,
              })
            )
              continue;

            try {
              const engine = new CompactionEngine(
                deps.db,
                deps.transcriptParser,
                deps.memoryIndex,
                deps.config,
              );
              const compactionDate = getEarliestMessageDate(deps.db, chatId, session.sessionId, session.sinceTimestamp);
              await engine.compact({
                chatId,
                sessionId: session.sessionId,
                llmCall,
                compactionDate,
                sinceTimestamp: session.sinceTimestamp,
              });
              logInfo(TAG, `Daily compaction completed for chat ${chatId}, session ${session.sessionId}`);
            } catch (err) {
              logError(
                TAG,
                `Daily compaction failed for chat ${chatId}, session ${session.sessionId}`,
                err,
              );
              // Continue to next session
            }
          }
        } finally {
          release();
        }
      }
    },
  };
}

/**
 * Startup catch-up: compact all previous-day uncompacted sessions.
 *
 * Scans all active chats for sessions whose messages are entirely from previous
 * calendar days and compacts them immediately. Unlike the heartbeat task, this
 * skips the inactivity-gap check — previous-day messages are definitively "done".
 *
 * Errors per session are logged and do not halt processing of remaining sessions.
 */
export async function runStartupCatchUp(deps: DailyCompactionDeps): Promise<void> {
  const llmCall = deps.getLlmCall();
  if (!llmCall) {
    logDebug(TAG, "LLM call unavailable — skipping startup catch-up");
    return;
  }

  // Get all active chats from messages table (sessions table may be empty for tmux transport)
  const chats = deps.db
    .prepare("SELECT DISTINCT chat_id FROM messages")
    .all() as Array<{ chat_id: number }>;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  for (const chat of chats) {
    const chatId = chat.chat_id;
    const sessions = getUncompactedSessions(deps.db, chatId);

    for (const session of sessions) {
      // Skip sessions whose last message is from today (current calendar day)
      if (session.lastMessageTimestamp >= todayStartMs) continue;

      try {
        const engine = new CompactionEngine(deps.db, deps.transcriptParser, deps.memoryIndex, deps.config);
        const compactionDate = getEarliestMessageDate(deps.db, chatId, session.sessionId, session.sinceTimestamp);
        await engine.compact({
          chatId,
          sessionId: session.sessionId,
          llmCall,
          compactionDate,
          sinceTimestamp: session.sinceTimestamp,
        });
        logInfo(TAG, `Startup catch-up compacted chat ${chatId}, session ${session.sessionId}`);
      } catch (err) {
        logError(TAG, `Startup catch-up failed for chat ${chatId}, session ${session.sessionId}`, err);
        // Continue to next session
      }
    }
  }
}
