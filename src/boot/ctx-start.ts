/**
 * Process-local context-window markers used by recall fallback stages.
 *
 * They intentionally do not write inside the abmind-owned memory directory.
 */

const contextWindowStarts = new Map<string, number>();

/** Update context-window-start timestamp for a chat. */
export function updateCtxStart(memoryDir: string, userId: string, ts = Date.now()): void {
  void memoryDir;
  contextWindowStarts.set(userId, ts);
}

/** Set all context-window-start entries to now (called after sleep). */
export function resetAllCtxStarts(memoryDir: string): void {
  void memoryDir;
  const now = Date.now();
  for (const key of contextWindowStarts.keys()) contextWindowStarts.set(key, now);
}
