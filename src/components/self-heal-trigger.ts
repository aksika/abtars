/**
 * self-heal-trigger.ts — On-demand self-healing with user notification.
 * Universal flow: notify → heal → report.
 */
import { logInfo, logWarn } from "./logger.js";

const TAG = "self-heal";

export interface SelfHealDeps {
  enabled: boolean;
  sendNotification: (chatId: string, text: string) => void;
  heal: (source: string, error: string) => Promise<boolean>;
}

/**
 * Trigger self-healing for a failed operation.
 * Notifies user at each stage. Returns true if healed.
 */
export async function triggerSelfHeal(
  source: string,
  error: string,
  chatId: number,
  deps: SelfHealDeps,
): Promise<boolean> {
  deps.sendNotification(String(chatId), `⚠️ ${source} failed`);

  if (!deps.enabled) return false;

  deps.sendNotification(String(chatId), `🔧 Calling self-healing agent`);
  logInfo(TAG, `Healing "${source}": ${error.slice(0, 200)}`);

  try {
    const fixed = await deps.heal(source, error);
    if (fixed) {
      deps.sendNotification(String(chatId), `✓ Self-healed`);
      logInfo(TAG, `"${source}" healed successfully`);
      return true;
    }
  } catch (err) {
    logWarn(TAG, `Heal attempt failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  deps.sendNotification(String(chatId), `⛔ Needs manual fix, further errors suppressed`);
  return false;
}
