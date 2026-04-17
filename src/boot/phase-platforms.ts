/**
 * phase-platforms — boot phase 6: register + start Telegram and Discord.
 *
 * Registers both on ctx.registry. Starts each if flagged in ctx.platforms.
 * Populates ctx.telegramAdapter / ctx.discordAdapter on successful create,
 * and ctx.platformAdapters map (used by heartbeat, sleep, command handlers).
 *
 * Must run after phase-pipeline-deps (adapters consume ctx.pipelineDeps).
 *
 * No singletons owned. Writes to ctx and to bridge.* for legacy callers.
 */

import { logInfo, logWarn, logError } from "../components/logger.js";
import type { BootCtx } from "./context.js";
import type { Bridge } from "../bridge-app.js";

export async function phasePlatforms(ctx: BootCtx, bridge: Bridge): Promise<void> {
  const { config, platforms, transport, memory, conversationBuffer, pipelineDeps, registry, platformAdapters } = ctx;
  if (!transport || !pipelineDeps) throw new Error("phase-platforms: pipeline-deps must run first");

  // --- Telegram service ---
  registry.register("telegram", {
    configured: Boolean(config.telegram.botToken && config.telegram.allowedUserIds.size > 0),
    async create() {
      const { TelegramAdapter } = await import("../platforms/telegram/telegram-adapter.js");
      const adapter = new TelegramAdapter(
        { botToken: config.telegram.botToken, allowedUserIds: config.telegram.allowedUserIds, pollTimeoutS: config.telegram.pollTimeoutS },
        { pipeline: pipelineDeps, conversationBuffer, transport, memory },
      );
      ctx.telegramAdapter = adapter;
      bridge.telegramAdapter = adapter;
      platformAdapters.set("telegram", adapter);
      return {
        async start() { await adapter.start(); },
        stop() {
          adapter.stop();
          platformAdapters.delete("telegram");
          ctx.telegramAdapter = null;
          bridge.telegramAdapter = null;
        },
      };
    },
  });

  if (platforms.telegram) {
    const result = await registry.start("telegram");
    if (result.ok) {
      logInfo("main", "📡 Telegram polling started");
    } else {
      logError("main", `Telegram failed to start: ${result.error}`);
    }
  } else {
    logInfo("main", "📡 Telegram disabled (no --telegram flag)");
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
          allowedChannelIds: config.discord.allowedChannelIds!,
          a2aEnabled: config.discord.a2aEnabled,
          a2aChannelId: config.discord.a2aChannelId,
          a2aPeerBotId: config.discord.a2aPeerBotId,
          a2aRateLimitMs: config.discord.a2aRateLimitMs,
        },
        { pipeline: pipelineDeps, transport, memory, conversationBuffer },
      );
      ctx.discordAdapter = adapter;
      bridge.discordAdapter = adapter;
      platformAdapters.set("discord", adapter);
      return {
        async start() { await adapter.start(); },
        stop() {
          adapter.stop();
          platformAdapters.delete("discord");
          ctx.discordAdapter = null;
          bridge.discordAdapter = null;
        },
      };
    },
  });

  if (platforms.discord) {
    const result = await registry.start("discord");
    if (result.ok) {
      logInfo("main", "📡 Discord polling started");
    } else if (result.error?.includes("not configured")) {
      logWarn("main", "Discord flag set but not configured — skipping");
    } else {
      logError("main", `Discord failed to start: ${result.error}`);
    }
  } else {
    logInfo("main", "📡 Discord disabled (no --discord/--all flag)");
  }
}
