/**
 * sendNotification — send a notification to the user's main channel.
 * Tries Telegram first, falls back to Discord. Fire-and-forget.
 */

import type { BootCtx } from "../boot/context.js";

export function sendNotification(ctx: BootCtx, msg: string): void {
  const chatId = String(ctx.config.mainChatId ?? "");
  if (!chatId) return;
  if (ctx.telegramAdapter) {
    ctx.telegramAdapter.sendNotification(chatId, msg);
  } else if (ctx.discordAdapter) {
    ctx.discordAdapter.sendMessage(chatId, msg).catch(() => {});
  }
}
