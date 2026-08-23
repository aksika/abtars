/**
 * turn-utils.ts — #1693 Phase B: helpers shared by the two live Pi hosts
 * (standalone executor + interactive coding service).
 *
 * Deliberately tiny: only contracts that are byte-for-byte identical across
 * both hosts live here. Lifecycle/policy code stays host-local (see spec
 * #1693 deferred boundary — no TurnEngine, no shared CAS kernel).
 */

/** Official extension_ui_request methods that park a turn awaiting input. */
export const DIALOG_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

/** Bounded, content-free error text (never raw RPC frame content). */
export function boundedError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}
