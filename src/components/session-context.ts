import type { MemoryManager } from "./memory-manager.js";

export const SESSION_CONTEXT_CAP = 2000;

/**
 * Build session-start context for injection after /new, /reset, or restart.
 * Returns the latest daily summary, or recent messages if no daily covers the gap.
 * Capped at ~2000 chars (~400 tokens). Wrapped in REQ-4 temporal markers.
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
      "SELECT role, content, timestamp FROM messages WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 10"
    ).all(dailyTs) as { role: string; content: string; timestamp: number }[];
    rows.reverse();
    let buf = "";
    for (const r of rows) {
      const time = new Date(r.timestamp).toISOString().slice(11, 16);
      const line = `[${time}] ${r.role}: ${r.content}\n`;
      if (buf.length + line.length > SESSION_CONTEXT_CAP) break;
      buf += line;
    }
    body = buf.trim();
    endedAt = new Date(lastMsgTs).toISOString();
  } else if (daily) {
    // Overnight: use the full daily summary (sleep prompt caps these at ~3000 chars)
    body = daily.summary;
    endedAt = new Date(dailyTs).toISOString();
  } else if (lastMsgTs > 0) {
    // No daily at all — inject recent messages
    const rows = db.prepare(
      "SELECT role, content, timestamp FROM messages ORDER BY timestamp DESC LIMIT 10"
    ).all() as { role: string; content: string; timestamp: number }[];
    rows.reverse();
    let buf = "";
    for (const r of rows) {
      const time = new Date(r.timestamp).toISOString().slice(11, 16);
      const line = `[${time}] ${r.role}: ${r.content}\n`;
      if (buf.length + line.length > SESSION_CONTEXT_CAP) break;
      buf += line;
    }
    body = buf.trim();
    endedAt = new Date(lastMsgTs).toISOString();
  } else {
    return null;
  }

  if (!body) return null;

  return `[LAST SESSION SUMMARY — ended ${endedAt}]\n${body}\n[SESSION START — ${now}]`;
}
