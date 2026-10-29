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
import type { PipelineDeps } from "../components/message-pipeline.js";

/**
 * #1831: per-channel notice throttle — one brain-unavailable notice per chat
 * per unwired episode. Lives on BootCtx next to the recovery queue so
 * drainRecoveryQueue can reset it when wiring completes.
 */
export type RecoveryNoticeThrottle = Set<string>;

export function recoveryNoticeKey(msg: InboundMessage): string {
  return `${msg.platform}:${msg.channelId}`;
}

/** #1831: short brain-unavailable notice naming /status. */
export const RECOVERY_QUEUED_NOTICE = "⚠️ Brain unavailable — message queued. Check /status for boot state.";

/**
 * Minimal recovery handler — works without transport/memory/pipeline.
 * Handles read-only + recovery commands only. User messages get queued.
 *
 * #1468: every inbound message is offered to the boot-owned emergency
 * execution service first; only a "pass" reaches the degraded behaviors below.
 * Exported for the child-process E2E portfolio, which drives the production
 * recovery routing with real service lifecycle and platform delivery.
 */
export function createRecoveryHandler(ctx: BootCtx) {
  const messageQueue: Array<{ msg: InboundMessage; adapter: any }> = [];
  // #1831: one brain-unavailable notice per chat per unwired episode.
  const noticedChannels: RecoveryNoticeThrottle = new Set();

  async function notifyQueuedOnce(msg: InboundMessage, adapter: any): Promise<void> {
    // #1831: first queued message per chat per episode carries the notice;
    // later messages queue silently to avoid group and retry spam.
    const key = recoveryNoticeKey(msg);
    if (noticedChannels.has(key)) return;
    try {
      await adapter.sendMessage(msg.channelId, RECOVERY_QUEUED_NOTICE);
      // Consume the throttle only after the notice actually went out, so a
      // platform send failure does not silence the whole episode.
      noticedChannels.add(key);
    } catch (err) {
      // The message is already queued and will drain on wiring; a failed
      // notice must not reject the inbound path.
      logError("recovery", `Queued-notice send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handle(msg: InboundMessage, adapter: any): Promise<void> {
    const text = msg.text?.trim() ?? "";
    // #1831: one structured error log per unwired inbound — routing ids and
    // phase state only, never message content. Logged before the emergency
    // fast path so an emergency-served turn is still recorded as unwired.
    const kind = text.startsWith("/") ? "command" : "normal";
    logError("recovery", `Unwired inbound platform=${msg.platform} channel=${msg.channelId} sender=${msg.senderId} msg=${msg.messageId ?? "n/a"} kind=${kind} transport=${ctx.phaseHealth.get("transport")?.status ?? "unknown"} pipelineDeps=${ctx.phaseHealth.get("pipelineDeps")?.status ?? "unknown"}`);

    // #1468: emergency fast path first — claimed controls and owner turns
    // never queue behind the recovery handler.
    if (ctx.emergencyExecution) {
      try {
        if ((await ctx.emergencyExecution.handleInbound(msg, adapter)) === "handled") return;
      } catch (err) {
        // A service fault must never wedge the recovery boundary.
        logError("recovery", `Emergency handler failed (content-free): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!text.startsWith("/")) {
      // Not a command — queue for later (busyGuard will handle once pipeline wires)
      messageQueue.push({ msg, adapter });
      logTrace("boot", `recovery-handler: queued non-command message from ${msg.userId}`);
      await notifyQueuedOnce(msg, adapter);
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
        // #1468: live emergency state from the service snapshot.
        const emergency = ctx.emergencyExecution?.describeForOperator();
        if (emergency) lines.push(`  ${emergency}`);
        await adapter.sendMessage(msg.channelId, lines.join("\n"));
        return;
      }
      case "/help": {
        // #1468: advertise the emergency path when hailMary is configurable —
        // help rendering never initializes ACP.
        let emergencyHint = "";
        try {
          const { loadTransportStructured, resolveHailMary } = await import("../components/transport-config.js");
          const loadResult = loadTransportStructured();
          if (loadResult.ok && resolveHailMary(loadResult.config)) emergencyHint = ", /emergency";
        } catch { /* non-fatal */ }
        await adapter.sendMessage(msg.channelId, `⚠️ Degraded mode. Available: /status, /help, /restart, /update${emergencyHint}`);
        return;
      }
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
        // Unknown command — queue it with the same one-notice-per-episode rule
        messageQueue.push({ msg, adapter });
        await notifyQueuedOnce(msg, adapter);
        return;
    }
  }

  return { handle, messageQueue, noticedChannels };
}

export async function phasePlatformsConnect(ctx: BootCtx): Promise<PhaseResult> {
  const { config, platforms, registry, platformAdapters } = ctx;
  // #1468: the boot-owned emergency service is created at the early
  // platform/recovery composition boundary — before the recovery handler
  // accepts any message — and reused by the full pipeline via PipelineDeps.
  if (!ctx.emergencyExecution) {
    const { createEmergencyExecutionService } = await import("../components/emergency-execution-service.js");
    ctx.emergencyExecution = createEmergencyExecutionService(config.transport.workingDir);
  }
  const recovery = createRecoveryHandler(ctx);
  // Store recovery queue on ctx for phasePipelineDeps to drain
  (ctx as any)._recoveryQueue = recovery.messageQueue;
  // #1831: per-chat notice throttle — drainRecoveryQueue resets it on wiring
  (ctx as any)._recoveryNoticeThrottle = recovery.noticedChannels;

  // --- Telegram service ---
  registry.register("telegram", {
    configured: Boolean(config.telegram.botToken && config.telegram.allowedUserIds.size > 0),
    async create() {
      const { TelegramAdapter } = await import("../platforms/telegram/telegram-adapter.js");
      // Construct with placeholder deps — setMessageHandler() replaces the
      // whole object on wiring. The degraded route marks this deps object as
      // unwired (#1831); pipeline is an empty placeholder, never called.
      const adapter = new TelegramAdapter(
        { botToken: config.telegram.botToken, allowedUserIds: config.telegram.allowedUserIds, pollTimeoutS: config.telegram.pollTimeoutS },
        { pipeline: {} as unknown as PipelineDeps, conversationBuffer: ctx.conversationBuffer, transport: null as any, memoryRuntime: ctx.memoryRuntime, sessionManager: ctx.sessionManager, actionGate: ctx.actionGate, degraded: { handle: (msg, adapter) => recovery.handle(msg, adapter) } },
      );
      ctx.telegramAdapter = adapter;
      platformAdapters.set("telegram", adapter);
      // Retry path (#1306): if phasePipelineDeps already ran, wire the full pipeline
      // onto this new instance now — the boot path won't run again.
      if (ctx.pipelineDeps) {
        const { wireTelegram, drainRecoveryQueue } = await import("./wire-platform.js");
        await wireTelegram(ctx);
        await drainRecoveryQueue(ctx);
      }
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
    configured: Boolean(config.discord.enabled && config.discord.botToken && config.discord.allowedUserIds?.size),
    async create() {
      const { isValidSnowflake } = await import("../components/config.js");
      if (!config.discord.appId || !isValidSnowflake(config.discord.appId)) {
        throw new Error("DISCORD_APP_ID missing or invalid — Discord disabled");
      }
      const { DiscordAdapter } = await import("../platforms/discord/discord-adapter.js");
      // Placeholder deps — setMessageHandler() replaces the whole object on
      // wiring. The degraded route marks this deps object as unwired (#1831);
      // pipeline is an empty placeholder, never called.
      const adapter = new DiscordAdapter(
        { botToken: config.discord.botToken!, appId: config.discord.appId!, allowedUserIds: config.discord.allowedUserIds! },
        { pipeline: {} as unknown as PipelineDeps, transport: null as any, memoryRuntime: ctx.memoryRuntime, conversationBuffer: ctx.conversationBuffer, degraded: { handle: (msg, adapter) => recovery.handle(msg, adapter) } },
      );
      ctx.discordAdapter = adapter;
      platformAdapters.set("discord", adapter);
      // Retry path (#1306): wire full pipeline if phasePipelineDeps already ran.
      if (ctx.pipelineDeps) {
        const { wireDiscord, drainRecoveryQueue } = await import("./wire-platform.js");
        await wireDiscord(ctx);
        await drainRecoveryQueue(ctx);
      }
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

  // --- TUI (#1315) ---
  // Bridge-side socket adapter for the abtars tui client. The daemon never
  // imports pi-tui — only the foreground client does. The adapter is a
  // thin pipe: socket frames ⇄ InboundMessage / response frames, routed
  // through the standard message pipeline. Spin owns the session.
  registry.register("tui", {
    configured: platforms.tui,
    async create() {
      const { TuiSocketAdapter } = await import("../platforms/tui/tui-socket-adapter.js");
      const adapter = new TuiSocketAdapter({
        spin: ctx.sessionManager,
        onMessage: (msg) => recovery.handle(msg, adapter),
        orcActivityFeed: ctx.orcActivityFeed,
        sessionOutputFeed: ctx.sessionOutputFeed,
        // #1635 Phase 2 — native TUI handoff. #1690: this is always null here
        // (boot-pi runs after the platforms phase); the adapter resolves the
        // live service from the coding-route registry at handoff time.
        codingService: ctx.codingSessionService ?? null,
      });
      platformAdapters.set("tui", adapter);
      // Retry path (#1306): wire full pipeline if phasePipelineDeps already ran.
      if (ctx.pipelineDeps) {
        const { wireTui, drainRecoveryQueue } = await import("./wire-platform.js");
        await wireTui(ctx);
        await drainRecoveryQueue(ctx);
      }
      return {
        async start() { await adapter.start(); },
        stop() { adapter.stop(); platformAdapters.delete("tui"); },
      };
    },
  });

  if (platforms.tui) {
    const result = await registry.start("tui", { backgroundRetry: true });
    if (result.ok) logInfo("main", "🖥️  TUI socket server listening (recovery handler active)");
    else logError("main", `TUI socket server failed: ${result.error}`);
  }

  return "ran";
}
