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

import type { ToolDefinition, ToolExecutionContext } from "./tool-registry.js";
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
 * (relay/identity-confusion). Keys off the active card's `source` — not the
 * session — so it stays correct for the shared singleton Orc (owner-initiated
 * delegation on an owner card is still allowed).
 *
 * #1480: When orcContext is available, uses its immutable origin instead.
 */
export async function isActiveCardPeerSourced(context?: ToolExecutionContext): Promise<boolean> {
  if (!context?.orcContext) return false;
  const { authorizePeerEgress } = await import("../orc-project/orc-project-context.js");
  const result = authorizePeerEgress({ orcContext: context.orcContext });
  return !result.allowed;
}

// ── Export ────────────────────────────────────────────────────────────────────

/** #1792: empty — the supervised choreography surface is deleted. */
export function getOrcTools(): ToolDefinition[] {
  return [];
}
