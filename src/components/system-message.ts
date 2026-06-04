/**
 * system-message.ts — Generic system message sender.
 *
 * Any component can send a system prompt to the agent and have the response
 * delivered to the user. Initialized once during bridge startup.
 *
 * Usage:
 *   import { sendSystemMessage } from "./system-message.js";
 *   await sendSystemMessage("[SYSTEM] You are getting sleepy...");
 */

import { logInfo, logWarn } from "./logger.js";

const TAG = "system-msg";

type MessageSender = (prompt: string) => Promise<void>;

let _sender: MessageSender | null = null;

/** Initialize the system message sender. Called once during bridge startup. */
export function initSystemMessage(sender: MessageSender): void {
  _sender = sender;
  logInfo(TAG, "System message sender initialized");
}

/**
 * Send a system prompt to the agent. The agent's response is delivered to the user.
 * No-op if sender not initialized (e.g. during tests or standalone memory use).
 */
export async function sendSystemMessage(prompt: string): Promise<void> {
  if (!_sender) {
    logWarn(TAG, "System message sender not initialized — message dropped");
    return;
  }
  logInfo(TAG, `Sending system message (${prompt.length} chars)`);
  await _sender(prompt);
}
