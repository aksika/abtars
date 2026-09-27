/**
 * session-control/rehydrate.ts — post-compaction core-bundle rehydration (#1869).
 *
 * The split moved profile/notes/coreFacts out of the boot system prompt into
 * session-start entries, which provider compaction summarizes away with
 * nothing re-injecting them. Marking the compacted session for core
 * rehydration makes its next turn re-inject those parts from a fresh read.
 * No refresh machinery, no pinning: restoration after the evicting event,
 * not immunity from it.
 *
 * Deliberately narrower than pendingStart. A full session start also
 * re-injects history hydration (consolidations plus recent message pairs,
 * up to the session-history budget), which after a compaction would partly
 * undo the reduction that just ran and re-add raw copies of messages the
 * fresh summary already represents.
 */

import type { SessionControlTarget } from "./types.js";

/** Narrow lookup: rehydration touches only the core-rehydration flag, so the
 *  contract names exactly that. A full ManagedSession satisfies it. */
export type SessionLookup = (sessionId: string) => { pendingCoreRehydrate?: boolean } | undefined;

/**
 * Mark the compacted session for core rehydration. Durable-conversation
 * sessionIds are spin session keys, so a completed checkpoint re-arms the
 * next turn's core injection. Local Pi runs match no spin session (coding
 * runs never carried core files) and are a deliberate no-op.
 */
export function rehydrateCompactedSession(target: SessionControlTarget, lookup: SessionLookup): void {
  if (target.kind !== "durable_conversation") return;
  const session = lookup(target.sessionId);
  if (session !== undefined) {
    session.pendingCoreRehydrate = true;
  }
}
