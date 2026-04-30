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
import { cleanResponse } from "../components/clean-response.js";
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
    const dcUser = loadUsers().users.find(u => u.platforms.discord);
    const channelId = dcUser?.allowedChats?.[0] ?? dcUser?.platforms.discord;
    if (channelId) await discordAdapter.sendMessage(String(channelId), msg);
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
      const entry = ctx.sessions.getOrCreate(sessionKey);
      entry.seen = true;
      entry.busy = true;
      startSession(
        transport,
        memory,
        loadUsers().byPlatformId.get(`telegram:${chatId}`)?.userId ?? "master",
        sessionKey,
        "You just came online. Output ONLY a personalized greeting message.",
        async (text) => {
          const { text: clean, reactionEmoji } = cleanResponse(text);
          if (clean) await telegramAdapter.sendMessage(String(chatId), clean);
          if (reactionEmoji) await telegramAdapter.sendMessage(String(chatId), reactionEmoji);
        },
      ).then(() => {
        logInfo("main", "✅ Startup session ready");
      }).catch(async (err) => {
        logWarn("main", `Startup greeting failed (attempt 1): ${err instanceof Error ? err.message : String(err)}`);
        // #328: retry once after 60s (model may still be loading after deploy)
        await new Promise(r => setTimeout(r, 60_000));
        try {
          await startSession(
            transport,
            memory!,
            loadUsers().byPlatformId.get(`telegram:${chatId}`)?.userId ?? "master",
            sessionKey,
            "You just came online. Output ONLY a personalized greeting message.",
            async (text) => {
              const { text: clean, reactionEmoji } = cleanResponse(text);
              if (clean) await telegramAdapter.sendMessage(String(chatId), clean);
              if (reactionEmoji) await telegramAdapter.sendMessage(String(chatId), reactionEmoji);
            },
          );
          logInfo("main", "✅ Startup session ready (retry succeeded)");
        } catch (retryErr) {
          logWarn("main", `Startup greeting retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
        }
      }).finally(() => {
        ctx.sessions.getOrCreate(sessionKey).busy = false;
      });
    }
  }
}
