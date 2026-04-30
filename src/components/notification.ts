/**
 * sendNotification — send a notification to the operator's main channel.
 * Routes via MAIN_CHAT_PROVIDER. Fire-and-forget.
 */

import type { BootCtx } from "../boot/context.js";
import { sendToMainChat } from "./main-chat.js";

export function sendNotification(ctx: BootCtx, msg: string): void {
  sendToMainChat(
    { telegram: ctx.telegramAdapter, discord: ctx.discordAdapter },
    msg,
  ).catch(() => {});
}
