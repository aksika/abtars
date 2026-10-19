import { logWarn } from "../logger.js";

const TAG = "pi-archive-outbox";

/**
 * Bounded operational outbox for required terminal archive writes (R4).
 *
 * When a turn's required terminal assistant record fails after delivery,
 * the payload is held here keyed by session. The next turn on that session
 * retries the held write under its original operation key (the server keeps
 * the first row, so a lost acknowledgement retries safely) and only admits
 * the provider request after durable confirmation. Until then, admission
 * stays closed: later requests cannot silently cross a known archive gap.
 *
 * Scope notes:
 * - One entry per session; entries clear on acknowledgement. A crash loses
 *   unacknowledged crash-window output — that is declared reconstruction
 *   loss (R5), not a silent gap; only live-process obligations are fenced.
 * - Sessions that never archive (guest, skill-isolated, memory-disabled)
 *   never hold entries, so they are never fenced.
 */
export interface PendingArchiveRecord {
  role: "assistant";
  content: string;
  timestamp: number;
  userId: string;
  sessionId: string;
  platformMessageId?: string;
  operationKey: string;
}

/**
 * Mirrors the abmind store's deliberate drop rules (message-store.ts):
 * empty content, [NO_REPLY]/connection-test markers, and long assistant
 * bracket/brace blobs are never recorded by policy. Those are not archive
 * gaps — noting them would wedge the session, since no retry could ever
 * confirm them. Everything else is recordable: a missing durable id for
 * recordable content is a real gap that must fail the next turn closed.
 */
export function isRecordableTerminalContent(content: string, role: "assistant"): boolean {
  if (!content.trim()) return false;
  if (/\[NO_REPLY\]|connection test/i.test(content)) return false;
  if (role === "assistant" && /^\s*[\[{]/.test(content) && content.length > 200) return false;
  return true;
}

export type ArchiveRecordFn = (input: {
  role: "assistant";
  content: string;
  timestamp: number;
  userId: string;
  sessionId: string;
  platformMessageId?: string;
}, operationKey: string) => Promise<{ id: number | null } | null>;

const MAX_PENDING_SESSIONS = 256;

export class PiArchiveOutbox {
  private readonly pending = new Map<string, PendingArchiveRecord>();

  /** Hold a required terminal write until it is durably confirmed. */
  note(record: PendingArchiveRecord): void {
    // Policy-dropped content is not an archive gap: the store would reject
    // it again on every retry, so holding it would wedge the session.
    if (!isRecordableTerminalContent(record.content, record.role)) return;
    if (!this.pending.has(record.sessionId) && this.pending.size >= MAX_PENDING_SESSIONS) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) {
        // Capacity fence: dropping an unacknowledged obligation reopens a
        // silent gap, so this must stay loud and effectively unreachable
        // (one entry per session; sessions are already bounded).
        logWarn(TAG, `outbox full; evicting oldest unacknowledged record for session "${oldest.value}"`);
        this.pending.delete(oldest.value);
      }
    }
    this.pending.set(record.sessionId, record);
  }

  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  peek(sessionId: string): PendingArchiveRecord | undefined {
    return this.pending.get(sessionId);
  }

  clear(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  /**
   * Retry the held write under its original operation key. Returns true
   * only on durable confirmation (numeric id), clearing the obligation.
   * Never throws: a failed retry keeps the obligation for the next turn.
   */
  async flush(sessionId: string, record: ArchiveRecordFn): Promise<boolean> {
    const held = this.pending.get(sessionId);
    if (!held) return true;
    try {
      const result = await record(
        {
          role: held.role,
          content: held.content,
          timestamp: held.timestamp,
          userId: held.userId,
          sessionId: held.sessionId,
          ...(held.platformMessageId !== undefined ? { platformMessageId: held.platformMessageId } : {}),
        },
        held.operationKey,
      );
      if (result !== null && typeof result.id === "number") {
        this.pending.delete(sessionId);
        return true;
      }
      return false;
    } catch {
      // A failed retry keeps the obligation; the caller fails the turn
      // closed and the next turn retries again.
      return false;
    }
  }

  get size(): number {
    return this.pending.size;
  }
}

/**
 * Shared live-process instance. Prompt construction (retry-or-fail-closed)
 * and the host gate (read-only denial) share it; tests inject their own via
 * the optional deps field instead of touching this.
 */
export const sharedArchiveOutbox = new PiArchiveOutbox();
