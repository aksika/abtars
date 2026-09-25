/**
 * orc-tools.ts — Orc-specific tool surface (#1005).
 *
 * #1792: the supervised Orc choreography tools (spawn_worker, check_workers,
 * cancel_worker, review_worker_failure, define_project_contract,
 * get_project_review_case, review_project, yield_turn) are deleted. Every
 * tool was gated on `context?.orcContext` (Orc project-turn sessions) and no
 * production code creates O-turns anymore, so the tools were unreachable in
 * production — they only returned "[err] No active Orc project" if invoked.
 * `getOrcTools()` returns an empty array; the tool-registry spread is a no-op.
 *
 * Retained:
 * - `isActiveCardPeerSourced` — live relay guard (peer-help-tools,
 *   tool-registry).
 * - `setOrcToolsDeps` — phase-transport still calls it; harmless.
 */

import type { ToolDefinition, ToolExecutionContext, WorkOrigin } from "./tool-registry.js";
import type { SessionDispatch } from "./session-dispatch.js";

let _sessionDispatch: SessionDispatch | null = null;

export function setOrcToolsDeps(sessionDispatch: SessionDispatch): void {
  _sessionDispatch = sessionDispatch;
}

// #1792: the dispatch handle is retained for the phase-transport call shape
// only — no tool reads it anymore. The void read keeps noUnusedLocals quiet
// without adding API.
void _sessionDispatch;

/**
 * #1301 — true when the Orc is currently processing a peer-originated card.
 *
 * Relay tools (peer_session/peer_doorbell/peer_ask_help) call this to refuse: a
 * peer must never be able to make us call a THIRD peer under our identity
 * (relay/identity-confusion).
 *
 * Two complementary signals, in precedence order:
 * 1. A bound `orcContext` (O sessions) — the live-validated turn origin.
 * 2. A dispatch-resolved `workOrigin` (W workers, which never bind a turn
 *    context) — the durable root origin. Peer or unresolvable origins refuse;
 *    owner origins allow.
 * Contexts with neither (owner chats, composition turns) keep legacy
 * behavior: not peer-sourced.
 *
 * #1850: the orcContext-only check was fail-open for every supervised W
 * worker after #1792 removed all production paths that set one — the relay
 * escaped twice live. The durable path closes it.
 */
export async function isActiveCardPeerSourced(context?: ToolExecutionContext): Promise<boolean> {
  if (context?.orcContext) {
    const { authorizePeerEgress } = await import("../orc-project/orc-project-context.js");
    const result = authorizePeerEgress({ orcContext: context.orcContext });
    return !result.allowed;
  }
  const origin = context?.workOrigin;
  if (origin === undefined) return false;
  return origin.rootKind === "peer" || origin.rootKind === "unknown";
}

/** Lookup surface for origin resolution (injected for tests). */
export interface WorkOriginLookup {
  getCardSource(cardId: number): { source: string | null; sourcePeer: string | null } | undefined;
  getRunKind(rootCardId: number): string | null;
}

/**
 * #1850: resolve a worker execution's trusted origin from host-owned durable
 * state. Peer when the root card source or any workflow run for the root
 * says peer; owner kinds pass through; anything unreadable or unrecognized
 * resolves unknown, which the guard denies (fail closed).
 */
export function resolveWorkOrigin(rootCardId: number, lookup: WorkOriginLookup): WorkOrigin {
  const card = lookup.getCardSource(rootCardId);
  if (!card) return { rootCardId, rootKind: "unknown", sourcePeer: null };
  const runKind = lookup.getRunKind(rootCardId);
  if (card.source === "peer" || runKind === "peer") {
    return { rootCardId, rootKind: "peer", sourcePeer: card.sourcePeer };
  }
  if (runKind === "scheduled" || runKind === "interactive") {
    return { rootCardId, rootKind: runKind, sourcePeer: card.sourcePeer };
  }
  if (card.source === "task") return { rootCardId, rootKind: "scheduled", sourcePeer: card.sourcePeer };
  if (card.source === "user" || card.source === "agent") {
    return { rootCardId, rootKind: "interactive", sourcePeer: card.sourcePeer };
  }
  return { rootCardId, rootKind: "unknown", sourcePeer: card.sourcePeer };
}

// ── Export ────────────────────────────────────────────────────────────────────

/** #1792: empty — the supervised choreography surface is deleted. */
export function getOrcTools(): ToolDefinition[] {
  return [];
}
