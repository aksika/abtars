import type { MemoryManager } from "./memory-manager.js";

export const RECENT_MSG_LIMIT = 8;
export const RECENT_MSG_CAP = 2500;

type MsgRow = { role: string; content: string; timestamp: number };

/**
 * Format recent messages for injection. Keeps newest messages intact —
 * drops oldest messages first if over the soft cap (never truncates mid-message).
 */
function formatRecentMessages(rows: MsgRow[]): string {
  // rows come DESC from DB — reverse to chronological
  const chronological = [...rows].reverse();
  const lines = chronological.map(r => {
    const time = new Date(r.timestamp).toISOString().slice(11, 16);
    return `[${time}] ${r.role}: ${r.content}`;
  });

  // Drop oldest lines until under cap
  while (lines.length > 1) {
    const total = lines.join("\n").length;
    if (total <= RECENT_MSG_CAP) break;
    lines.shift();
  }

  return lines.join("\n");
}

/**
 * Build session-start context for injection after /new, /reset, or restart.
 * Returns the latest daily summary, or recent messages if no daily covers the gap.
 * Wrapped in REQ-4 temporal markers.
 */
export function buildSessionStartContext(memory: MemoryManager, chatId: number): string | null {
  const db = memory.getDb();
  if (!db) return null;

  const daily = memory.getLatestCompaction(chatId);
  const dailyTs = daily?.timestamp ?? 0;

  const lastMsg = db.prepare(
    "SELECT MAX(timestamp) as ts FROM messages WHERE role = 'user'"
  ).get() as { ts: number | null } | undefined;
  const lastMsgTs = lastMsg?.ts ?? 0;

  const now = new Date().toISOString();
  let body: string;
  let endedAt: string;

  if (lastMsgTs > dailyTs && dailyTs > 0) {
    // Midday restart: messages exist after the daily — inject recent messages
    const rows = db.prepare(
      `SELECT role, content, timestamp FROM messages WHERE timestamp > ? ORDER BY timestamp DESC LIMIT ${RECENT_MSG_LIMIT}`
    ).all(dailyTs) as MsgRow[];
    body = formatRecentMessages(rows);
    endedAt = new Date(lastMsgTs).toISOString();
  } else if (daily) {
    // Overnight: use the full daily summary (sleep prompt caps these at ~3000 chars)
    body = daily.summary;
    endedAt = new Date(dailyTs).toISOString();
  } else if (lastMsgTs > 0) {
    // No daily at all — inject recent messages
    const rows = db.prepare(
      `SELECT role, content, timestamp FROM messages ORDER BY timestamp DESC LIMIT ${RECENT_MSG_LIMIT}`
    ).all() as MsgRow[];
    body = formatRecentMessages(rows);
    endedAt = new Date(lastMsgTs).toISOString();
  } else {
    return null;
  }

  if (!body) return null;

  return `[LAST SESSION SUMMARY — ended ${endedAt}]\n${body}\n[SESSION START — ${now}]`;
}
