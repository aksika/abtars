/**
 * phase-startup-notification — boot phase 8: "Back online" + startup session greeting.
 *
 * - Fires async "Back online" message to Telegram + Discord (non-blocking)
 * - Starts a session with SOUL + context + personalized greeting, pushes to Telegram
 *
 * Both actions are fire-and-forget; boot does not wait for them.
 * No-op if memory is disabled.
 *
 * No singletons owned.
 */

import { logInfo, logWarn } from "../components/logger.js";
import { loadUsers } from "../components/user-registry.js";
import { startSession } from "../components/message-pipeline.js";
import type { BootCtx } from "./context.js";

async function sendBackOnline(
  sendTelegram?: (msg: string) => Promise<void>,
  sendDiscord?: (msg: string) => Promise<void>,
): Promise<void> {
  const msg = "🔄 Back online.";
  logInfo("main", "Startup: Back online notification sent");
  const results = await Promise.allSettled([
    sendTelegram?.(msg).catch(() => {}),
    sendDiscord?.(msg).catch(() => {}),
  ]);
  for (const r of results) {
    if (r.status === "rejected") logWarn("main", `Back online send failed: ${r.reason}`);
  }
}

export async function phaseStartupNotification(ctx: BootCtx): Promise<void> {
  const { config, memoryConfig, memory, transport, telegramAdapter, discordAdapter } = ctx;
  if (!memoryConfig.memoryEnabled) return;

  const tgSend = telegramAdapter ? async (msg: string): Promise<void> => {
    const chatId = config.mainChatId;
    if (chatId) await telegramAdapter.sendMessage(String(chatId), msg);
  } : undefined;
  const dcSend = discordAdapter ? async (msg: string): Promise<void> => {
    const channelId = config.discord.allowedChannelIds ? [...config.discord.allowedChannelIds][0] : undefined;
    if (channelId) await discordAdapter.sendMessage(channelId, msg);
  } : undefined;

  sendBackOnline(tgSend, dcSend).catch((err) => {
    logWarn("main", `Back online notification error: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Startup session: SOUL + context + personalized greeting → Telegram
  if (telegramAdapter && memory && transport) {
    const chatId = config.mainChatId;
    if (chatId) {
      const masterUser = loadUsers().users.find(u => u.role === "master");
      const sessionKey = `${masterUser?.userId ?? "master"}:telegram`;
      ctx.seenSessions.add(sessionKey);
      ctx.busyChats.add(sessionKey);
      startSession(
        transport,
        memory,
        loadUsers().byPlatformId.get(`telegram:${chatId}`)?.userId ?? "master",
        sessionKey,
        "You just came online. Output ONLY a personalized greeting message.",
        (text) => {
          const clean = text.replace(/\s*\[NO-REPLY\]\s*/gi, "").trim();
          if (!clean) return Promise.resolve();
          return telegramAdapter.sendMessage(String(chatId), clean);
        },
      ).then(() => {
        logInfo("main", "✅ Startup session ready");
      }).catch(err => {
        logWarn("main", `Startup greeting failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
      }).finally(() => {
        ctx.busyChats.delete(sessionKey);
      });
    }
  }
}
