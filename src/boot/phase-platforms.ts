/**
 * phase-platforms — boot phase 6: register + start Telegram and Discord.
 *
 * Registers both on ctx.registry. Starts each if flagged in ctx.platforms.
 * Populates ctx.telegramAdapter / ctx.discordAdapter on successful create,
 * and ctx.platformAdapters map (used by heartbeat, sleep, command handlers).
 *
 * Must run after phase-pipeline-deps (adapters consume ctx.pipelineDeps).
 *
 * No singletons owned.
 */

import { logInfo, logWarn, logError } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";

export async function phasePlatforms(ctx: BootCtx): Promise<PhaseResult> {
  const { config, platforms, transport, memoryRuntime, conversationBuffer, pipelineDeps, registry, platformAdapters } = ctx;
  if (!transport || !pipelineDeps) { ctx.phaseHealth.set(phasePlatforms.name, { status: "skipped", error: "no transport" }); logWarn("boot", `${phasePlatforms.name}: skipping — transport not available`); return "skipped"; }

  // --- Telegram service ---
  registry.register("telegram", {
    configured: Boolean(config.telegram.botToken && config.telegram.allowedUserIds.size > 0),
    async create() {
      const { TelegramAdapter } = await import("../platforms/telegram/telegram-adapter.js");
      const adapter = new TelegramAdapter(
        { botToken: config.telegram.botToken, allowedUserIds: config.telegram.allowedUserIds, pollTimeoutS: config.telegram.pollTimeoutS },
        { pipeline: pipelineDeps, conversationBuffer, transport, memoryRuntime, sessionManager: ctx.sessionManager, actionGate: ctx.actionGate },
      );
      ctx.telegramAdapter = adapter;
      platformAdapters.set("telegram", adapter);
      return {
        async start() { await adapter.start(); },
        stop() {
          adapter.stop();
          platformAdapters.delete("telegram");
          ctx.telegramAdapter = null;
        },
      };
    },
  });

  if (platforms.telegram) {
    const result = await registry.start("telegram", { backgroundRetry: true });
    if (result.ok) {
      logInfo("main", "📡 Telegram polling started");
      // Wire send_document tool: binds mainChatId + adapter, exposes to tool-registry
      const mainChatId = config.mainChatId;
      if (mainChatId && ctx.telegramAdapter) {
        const { setSendDocument } = await import("../components/transport/tool-registry.js");
        setSendDocument((path, caption) => ctx.telegramAdapter!.sendDocument(String(mainChatId), path, caption));

        // Wire ActionGate Telegram notification
        if (ctx.actionGate) {
          const api = (ctx.telegramAdapter as any).api;
          const chatId = String(mainChatId);
          ctx.actionGate.setNotify(async (text: string, buttons: Array<{ text: string; data: string }>) => {
            const opts: any = {};
            if (buttons.length > 0) {
              opts.reply_markup = { inline_keyboard: [buttons.map(b => ({ text: b.text, callback_data: b.data }))] };
            }
            await api.sendMessage(chatId, text, opts);
          });
        }
      }
    } else if (result.retryingInBackground) {
      logWarn("main", `Telegram failed to start: ${result.error} — retrying in background`);
    } else {
      logError("main", `Telegram failed to start: ${result.error}`);
    }
  } else {
    logInfo("main", "📡 Telegram disabled (TELEGRAM_ENABLED=false)");
  }

  // --- Discord service ---
  registry.register("discord", {
    configured: Boolean(config.discord.enabled && config.discord.botToken),
    async create() {
      const { DiscordAdapter } = await import("../platforms/discord/discord-adapter.js");
      const adapter = new DiscordAdapter(
        {
          botToken: config.discord.botToken!,
          appId: config.discord.appId!,
          allowedUserIds: config.discord.allowedUserIds!,
        },
        { pipeline: pipelineDeps, transport, memoryRuntime, conversationBuffer },
      );
      ctx.discordAdapter = adapter;
      platformAdapters.set("discord", adapter);
      return {
        async start() { await adapter.start(); },
        stop() {
          adapter.stop();
          platformAdapters.delete("discord");
          ctx.discordAdapter = null;
        },
      };
    },
  });

  if (platforms.discord) {
    const result = await registry.start("discord", { backgroundRetry: true });
    if (result.ok) {
      logInfo("main", "📡 Discord polling started");
    } else if (result.error?.includes("not configured")) {
      logWarn("main", "Discord flag set but not configured — skipping");
    } else if (result.retryingInBackground) {
      logWarn("main", `Discord failed to start: ${result.error} — retrying in background`);
    } else {
      logError("main", `Discord failed to start: ${result.error}`);
    }
  } else {
    logInfo("main", "📡 Discord disabled (DISCORD_ENABLED=false)");
  }

  // ── IRC ──────────────────────────────────────────────────────────────────
  registry.register("irc", {
    configured: platforms.irc,
    async create() {
      const { loadIrcConfig } = await import("../platforms/irc/irc-config.js");
      const { IrcAdapter } = await import("../platforms/irc/irc-adapter.js");
      const { handleInboundMessage } = await import("../components/message-pipeline.js");
      const ircConfig = loadIrcConfig();
      if (!ircConfig) throw new Error("irc.json missing or empty");
      const adapter = new IrcAdapter(ircConfig, {
        onMessage: (msg) => handleInboundMessage(msg, adapter, pipelineDeps),
      });
      platformAdapters.set("irc", adapter);
      return {
        async start() { await adapter.start(); },
        stop() { adapter.stop(); platformAdapters.delete("irc"); },
      };
    },
  });

  if (platforms.irc) {
    const result = await registry.start("irc", { backgroundRetry: true });
    if (result.ok) {
      logInfo("main", "📡 IRC started");
      const { setIrcSend } = await import("../components/transport/tool-registry.js");
      const ircAdapter = platformAdapters.get("irc");
      if (ircAdapter) setIrcSend((channel, message) => { ircAdapter.sendMessage(channel, message); });
    } else if (result.error?.includes("not configured")) {
      logWarn("main", "IRC flag set but irc.json missing — skipping");
    } else {
      logError("main", `IRC failed to start: ${result.error}`);
    }
  }
  return "ran";
}
