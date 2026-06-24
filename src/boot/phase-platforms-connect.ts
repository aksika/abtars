/**
 * phase-platforms-connect — connect platforms early, wire handlers later (#944).
 *
 * Creates adapters with a minimal recovery handler (no transport/memory needed).
 * Starts polling so the bridge is reachable immediately.
 * Full handleInboundMessage wired later by phasePipelineDeps via setMessageHandler().
 *
 * Deps: config only. No transport, no memory, no pipelineDeps.
 */

import { logInfo, logWarn, logError, logTrace } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import type { InboundMessage } from "../types/platform.js";

/**
 * Minimal recovery handler — works without transport/memory/pipeline.
 * Handles read-only + recovery commands only. User messages get queued.
 */
function createRecoveryHandler(ctx: BootCtx) {
  const messageQueue: Array<{ msg: InboundMessage; adapter: any }> = [];

  async function handle(msg: InboundMessage, adapter: any): Promise<void> {
    const text = msg.text?.trim() ?? "";
    if (!text.startsWith("/")) {
      // Not a command — queue for later (busyGuard will handle once pipeline wires)
      messageQueue.push({ msg, adapter });
      logTrace("boot", `recovery-handler: queued non-command message from ${msg.userId}`);
      return;
    }

    const [cmd] = text.split(" ");
    switch (cmd) {
      case "/status": {
        const lines = ["🔧 Boot status:"];
        for (const [name, h] of ctx.phaseHealth) {
          const icon = h.status === "ok" ? "✓" : h.status === "failed" ? "✗" : "»";
          lines.push(`  ${icon} ${name}${h.error ? ` — ${h.error}` : ""}`);
        }
        await adapter.sendMessage(msg.channelId, lines.join("\n"));
        return;
      }
      case "/help":
        await adapter.sendMessage(msg.channelId, "⚠️ Degraded mode. Available: /status, /help, /restart, /update");
        return;
      case "/restart":
        await adapter.sendMessage(msg.channelId, "♻️ Restarting...");
        setTimeout(() => process.exit(0), 500);
        return;
      case "/update": {
        await adapter.sendMessage(msg.channelId, "🔄 Running update...");
        const { execFileSync } = await import("node:child_process");
        try {
          execFileSync("abtars", ["update"], { stdio: "pipe", timeout: 120_000 });
        } catch (err: any) {
          await adapter.sendMessage(msg.channelId, `❌ Update failed: ${err.message}`);
        }
        return;
      }
      default:
        // Unknown command — queue it
        messageQueue.push({ msg, adapter });
        return;
    }
  }

  return { handle, messageQueue };
}

export async function phasePlatformsConnect(ctx: BootCtx): Promise<PhaseResult> {
  const { config, platforms, registry, platformAdapters } = ctx;
  const recovery = createRecoveryHandler(ctx);
  // Store recovery queue on ctx for phasePipelineDeps to drain
  (ctx as any)._recoveryQueue = recovery.messageQueue;

  // --- Telegram service ---
  registry.register("telegram", {
    configured: Boolean(config.telegram.botToken && config.telegram.allowedUserIds.size > 0),
    async create() {
      const { TelegramAdapter } = await import("../platforms/telegram/telegram-adapter.js");
      // Construct with a placeholder deps — setMessageHandler() will replace later
      const adapter = new TelegramAdapter(
        { botToken: config.telegram.botToken, allowedUserIds: config.telegram.allowedUserIds, pollTimeoutS: config.telegram.pollTimeoutS },
        { pipeline: { handleInbound: (msg: any) => recovery.handle(msg, adapter) } as any, conversationBuffer: ctx.conversationBuffer, transport: null as any, memory: null, sessionManager: ctx.sessionManager, actionGate: ctx.actionGate },
      );
      ctx.telegramAdapter = adapter;
      platformAdapters.set("telegram", adapter);
      return {
        async start() { await adapter.start(); },
        stop() { adapter.stop(); platformAdapters.delete("telegram"); ctx.telegramAdapter = null; },
      };
    },
  });

  if (platforms.telegram) {
    const result = await registry.start("telegram", { backgroundRetry: true });
    if (result.ok) logInfo("main", "📡 Telegram connected (recovery handler active)");
    else if (result.retryingInBackground) logWarn("main", `Telegram connect failed: ${result.error} — retrying in background`);
    else logError("main", `Telegram connect failed: ${result.error}`);
  }

  // --- Discord service ---
  registry.register("discord", {
    configured: Boolean(config.discord.enabled && config.discord.botToken),
    async create() {
      const { isValidSnowflake } = await import("../components/config.js");
      if (!config.discord.appId || !isValidSnowflake(config.discord.appId)) {
        throw new Error("DISCORD_APP_ID missing or invalid — Discord disabled");
      }
      if (!config.discord.allowedUserIds?.size) {
        throw new Error("No Discord users in users.json — Discord disabled");
      }
      const { DiscordAdapter } = await import("../platforms/discord/discord-adapter.js");
      const adapter = new DiscordAdapter(
        { botToken: config.discord.botToken!, appId: config.discord.appId!, allowedUserIds: config.discord.allowedUserIds! },
        { pipeline: { handleInbound: (msg: any) => recovery.handle(msg, adapter) } as any, transport: null as any, memory: null, conversationBuffer: ctx.conversationBuffer },
      );
      ctx.discordAdapter = adapter;
      platformAdapters.set("discord", adapter);
      return {
        async start() { await adapter.start(); },
        stop() { adapter.stop(); platformAdapters.delete("discord"); ctx.discordAdapter = null; },
      };
    },
  });

  if (platforms.discord) {
    const result = await registry.start("discord", { backgroundRetry: true });
    if (result.ok) logInfo("main", "📡 Discord connected (recovery handler active)");
    else if (result.error?.includes("not configured")) logWarn("main", "Discord flag set but not configured — skipping");
    else if (result.retryingInBackground) logWarn("main", `Discord connect failed: ${result.error} — retrying in background`);
    else logError("main", `Discord connect failed: ${result.error}`);
  }

  // --- IRC ---
  registry.register("irc", {
    configured: platforms.irc,
    async create() {
      const { loadIrcConfig } = await import("../platforms/irc/irc-config.js");
      const { IrcAdapter } = await import("../platforms/irc/irc-adapter.js");
      const ircConfig = loadIrcConfig();
      if (!ircConfig) throw new Error("irc.json missing or empty");
      const adapter = new IrcAdapter(ircConfig, { onMessage: (msg) => recovery.handle(msg, adapter) });
      platformAdapters.set("irc", adapter);
      return {
        async start() { await adapter.start(); },
        stop() { adapter.stop(); platformAdapters.delete("irc"); },
      };
    },
  });

  if (platforms.irc) {
    const result = await registry.start("irc", { backgroundRetry: true });
    if (result.ok) logInfo("main", "📡 IRC connected (recovery handler active)");
    else if (result.error?.includes("not configured")) logWarn("main", "IRC flag set but irc.json missing — skipping");
    else logError("main", `IRC connect failed: ${result.error}`);
  }

  return "ran";
}
