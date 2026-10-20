/**
 * pi-port.ts — #1577 abtars-owned Pi port vocabulary.
 *
 * Product-owned types for the Pi integration boundary, expressed entirely in
 * abtars terms. This module MUST NOT import any `@earendil-works/*` package
 * (enforced by `pi-boundary.test.ts`): a port file that references Pi types
 * is not a port. Vocabulary only — no runtime code.
 */

// ── #1446: safety controller outcomes ───────────────────────────────────────

export type ToolDecision =
  | { decision: "execute" }
  | { decision: "error"; reason: string }
  | { decision: "skip" };

export type TurnDecision =
  | { decision: "continue" }
  | { decision: "stop"; reason: string }
  | { decision: "pause" };

/** Authorized product tool descriptor. Pi tool schemas stay in the adapter. */
export interface PortToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
