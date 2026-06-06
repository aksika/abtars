/**
 * main-chat.ts — Route operator messages to the correct platform.
 * Uses MAIN_CHAT_PROVIDER to decide telegram vs discord.
 */

import { getEnv } from "./env-schema.js";
import { logWarn, logError } from "./logger.js";
import { sanitizeOutbound } from "./sanitize-outbound.js";

export interface SendOpts {
  threadId?: number;
}

export interface SendResult {
  ok: boolean;
  reason?: "no-chat-id" | "adapter-missing" | "send-failed";
}

export type ChatAdapter = {
  sendMessage(chatId: string, text: string, opts?: any): Promise<unknown>;
};

export async function sendToMainChat(
  adapters: { telegram?: ChatAdapter | null; discord?: ChatAdapter | null },
  text: string,
  opts?: SendOpts,
): Promise<SendResult> {
  const chatId = getEnv().mainChatId;
  if (!chatId) {
    logWarn("main-chat", "no MAIN_CHAT_ID, skipping");
    return { ok: false, reason: "no-chat-id" };
  }
  const provider = getEnv().mainChatProvider;
  const adapter = provider === "discord" ? adapters.discord : adapters.telegram;
  if (!adapter) {
    logWarn("main-chat", `${provider} adapter not running, skipping`);
    return { ok: false, reason: "adapter-missing" };
  }
  try {
    await adapter.sendMessage(chatId, sanitizeOutbound(text), opts);
    return { ok: true };
  } catch (err) {
    logError("main-chat", `send failed: ${err}`);
    return { ok: false, reason: "send-failed" };
  }
}
