/**
 * completion-buffer.ts — Stores results from background sessions (#570).
 * Parent sessions check this buffer before each prompt to inject auto-notify.
 */

export interface CompletionEntry {
  sessionId: string;
  motherId: string;
  goal: string;
  status: "done" | "failed" | "terminated" | "timeout";
  result: string;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
}

const buffer = new Map<string, CompletionEntry[]>(); // key = motherId

export function addCompletion(entry: CompletionEntry): void {
  const list = buffer.get(entry.motherId) ?? [];
  list.push(entry);
  buffer.set(entry.motherId, list);
}

/** Drain all completions for a parent session (consumed once on next prompt). */
export function drainCompletions(motherId: string): CompletionEntry[] {
  const entries = buffer.get(motherId) ?? [];
  buffer.delete(motherId);
  return entries;
}

/** Check if there are pending completions for a parent. */
export function hasCompletions(motherId: string): boolean {
  return (buffer.get(motherId)?.length ?? 0) > 0;
}
