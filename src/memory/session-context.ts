import type { MemoryManager } from "./memory-manager.js";

export const RECENT_MSG_LIMIT = 8;
export const RECENT_MSG_CAP = 2500;

/** Format date in local time: YYYY-MM-DD HH:MM */
function formatLocal(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type MsgRow = { role: string; content: string; timestamp: number };

/**
 * Format recent messages for injection. Keeps newest messages intact —
 * drops oldest messages first if over the soft cap (never truncates mid-message).
 */
function formatRecentMessages(rows: MsgRow[]): string {
  // rows come DESC from DB — reverse to chronological, skip empty
  const chronological = [...rows].reverse().filter(r => r.content.trim());
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
  const daily = memory.getLatestCompaction(chatId);
  const dailyTs = daily?.timestamp ?? 0;

  const lastMsgTs = memory.store.getLastMessageTimestamp();

  const now = formatLocal(new Date());
  let body: string;
  let endedAt: string;

  if (lastMsgTs > dailyTs && dailyTs > 0) {
    const rows = memory.store.getMessagesSince(dailyTs, RECENT_MSG_LIMIT);
    body = formatRecentMessages(rows);
    endedAt = formatLocal(new Date(lastMsgTs));
  } else if (daily) {
    body = daily.summary;
    endedAt = formatLocal(new Date(dailyTs));
  } else if (lastMsgTs > 0) {
    const rows = memory.store.getMessagesSince(0, RECENT_MSG_LIMIT);
    body = formatRecentMessages(rows);
    endedAt = formatLocal(new Date(lastMsgTs));
  } else {
    return null;
  }

  if (!body) return null;

  return `[LAST SESSION SUMMARY — ended ${endedAt}]\n${body}\n[SESSION START — ${now}]`;
}
