/**
 * pending-callback.ts — Store pending prompts for callback-based A2A (#451).
 * When direct peer_session fails, the prompt is stored here. When the peer calls back,
 * agent-api-server returns the pending prompt instead of LLM-processing.
 */

type PendingEntry = { prompt: string; resolve: (answer: string) => void; reject: (err: Error) => void };

const pending = new Map<string, PendingEntry>();

/** Store a pending prompt and return a promise that resolves when the answer arrives. */
export function registerPending(peerName: string, prompt: string): Promise<string> {
  // Clear any stale entry
  if (pending.has(peerName)) pending.get(peerName)!.reject(new Error("superseded"));
  return new Promise((resolve, reject) => {
    pending.set(peerName.toLowerCase(), { prompt, resolve, reject });
  });
}

/** Check if there's a pending prompt for this peer. */
export function hasPending(peerName: string): boolean {
  return pending.has(peerName.toLowerCase());
}

/** Get and remove the pending prompt (peer called back). */
export function popPendingPrompt(peerName: string): string | null {
  const entry = pending.get(peerName.toLowerCase());
  if (!entry) return null;
  return entry.prompt;
}

/** Deliver the answer (peer sent the response back). */
export function resolvePending(peerName: string, answer: string): boolean {
  const entry = pending.get(peerName.toLowerCase());
  if (!entry) return false;
  pending.delete(peerName.toLowerCase());
  entry.resolve(answer);
  return true;
}

/** Timeout — reject the pending promise. */
export function rejectPending(peerName: string, reason: string): void {
  const entry = pending.get(peerName.toLowerCase());
  if (!entry) return;
  pending.delete(peerName.toLowerCase());
  entry.reject(new Error(reason));
}
