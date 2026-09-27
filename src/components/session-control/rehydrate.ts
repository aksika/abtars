/**
 * session-control/rehydrate.ts — post-compaction core-bundle rehydration (#1869).
 *
 * The split moved profile/notes/coreFacts out of the boot system prompt into
 * session-start entries, which provider compaction summarizes away with
 * nothing re-injecting them. Marking the compacted session pendingStart
 * makes its next turn re-run session-start assembly — a fresh read of the
 * current files, so a post-sleep change appears at the next session start or
 * the next compaction, whichever comes first. No refresh machinery, no
 * pinning: restoration after the evicting event, not immunity from it.
 */

import type { SessionControlTarget } from "./types.js";

/** Narrow lookup: rehydration touches only the session-start flag, so the
 *  contract names exactly that. A full ManagedSession satisfies it. */
export type SessionLookup = (sessionId: string) => { pendingStart: boolean } | undefined;

/**
 * Mark the compacted session for rehydration. Durable-conversation
 * sessionIds are spin session keys, so a completed checkpoint re-arms the
 * next turn's session-start assembly. Local Pi runs match no spin session
 * (coding runs never carried core files) and are a deliberate no-op — as is
 * an already-reset session, whose pendingStart is simply reaffirmed.
 */
export function rehydrateCompactedSession(target: SessionControlTarget, lookup: SessionLookup): void {
  if (target.kind !== "durable_conversation") return;
  const session = lookup(target.sessionId);
  if (session !== undefined) {
    session.pendingStart = true;
  }
}
