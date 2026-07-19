/**
 * wire-platform.ts — idempotent per-platform pipeline wiring (#1306).
 *
 * Called from two sites:
 *   1. phasePipelineDeps (boot path) — after ctx.pipelineDeps is set.
 *   2. factory.create() in phasePlatformsConnect (retry path) — when a new
 *      adapter instance is created after phasePipelineDeps already completed.
 *
 * Each function is a no-op when its prerequisite (adapter + pipelineDeps) is
 * absent, so it is safe to call unconditionally from both paths.
 */

import { logInfo, logWarn } from "../components/logger.js";
import type { BootCtx } from "./context.js";

const TAG = "boot";

/** Wire the full Telegram pipeline onto ctx.telegramAdapter. Idempotent. */
export async function wireTelegram(ctx: BootCtx): Promise<void> {
  const adapter = ctx.telegramAdapter;
  if (!adapter || !ctx.pipelineDeps || !ctx.transport) return;

  adapter.setMessageHandler({
    pipeline: ctx.pipelineDeps,
    conversationBuffer: ctx.conversationBuffer,
    transport: ctx.transport,
    memoryRuntime: ctx.memoryRuntime,
    sessionManager: ctx.sessionManager,
    actionGate: ctx.actionGate,
  });

  // Re-bind send_document tool + ActionGate notify to THIS adapter instance.
  // These are stateful globals that must always point to the live instance.
  const mainChatId = ctx.config.mainChatId;
  if (mainChatId) {
    const { setSendDocument } = await import("../components/transport/tool-registry.js");
    setSendDocument((path, caption) => adapter.sendDocument(String(mainChatId), path, caption));
    if (ctx.actionGate) {
      const api = (adapter as unknown as { api: { sendMessage(chatId: string, text: string, opts?: unknown): Promise<unknown> } }).api;
      const chatId = String(mainChatId);
      ctx.actionGate.setNotify(async (text: string, buttons: Array<{ text: string; data: string }>) => {
        const opts: Record<string, unknown> = {};
        if (buttons.length > 0) {
          opts["reply_markup"] = { inline_keyboard: [buttons.map(b => ({ text: b.text, callback_data: b.data }))] };
        }
        await api.sendMessage(chatId, text, opts);
      });
    }
  }

  logInfo(TAG, "Telegram: full pipeline wired");
}

/** Wire the full Discord pipeline onto ctx.discordAdapter. Idempotent. */
export async function wireDiscord(ctx: BootCtx): Promise<void> {
  const adapter = ctx.discordAdapter;
  if (!adapter || !ctx.pipelineDeps || !ctx.transport) return;

  adapter.setMessageHandler({
    pipeline: ctx.pipelineDeps,
    transport: ctx.transport,
    memoryRuntime: ctx.memoryRuntime,
    conversationBuffer: ctx.conversationBuffer,
  });

  logInfo(TAG, "Discord: full pipeline wired");
}

/** Wire the full IRC pipeline + send tool onto the IRC adapter. Idempotent. */
export async function wireIrc(ctx: BootCtx): Promise<void> {
  const adapter = ctx.platformAdapters.get("irc");
  if (!adapter || !ctx.pipelineDeps) return;

  const pipelineDeps = ctx.pipelineDeps;

  if ("setMessageHandler" in adapter) {
    const { handleInboundMessage } = await import("../components/message-pipeline.js");
    (adapter as unknown as { setMessageHandler(cb: (msg: unknown) => void): void })
      .setMessageHandler((msg) => { void handleInboundMessage(msg as never, adapter as never, pipelineDeps); });

    const { setIrcSend } = await import("../components/transport/tool-registry.js");
    setIrcSend((channel, message) => { adapter.sendMessage(channel, message); });

    logInfo(TAG, "IRC: full pipeline wired");
  }
}

/** Wire the full TUI pipeline onto the TUI socket adapter (#1315). Idempotent. */
export async function wireTui(ctx: BootCtx): Promise<void> {
  const adapter = ctx.platformAdapters.get("tui");
  if (!adapter || !ctx.pipelineDeps) return;

  const pipelineDeps = ctx.pipelineDeps;

  if ("setMessageHandler" in adapter) {
    const { handleInboundMessage } = await import("../components/message-pipeline.js");
    (adapter as unknown as { setMessageHandler(cb: (msg: unknown) => void): void })
      .setMessageHandler((msg) => { void handleInboundMessage(msg as never, adapter as never, pipelineDeps); });

    logInfo(TAG, "TUI: full pipeline wired");
  }
}

/** Drain messages queued by the recovery handler while the pipeline was down. */
export async function drainRecoveryQueue(ctx: BootCtx): Promise<void> {
  const queue = (ctx as unknown as { _recoveryQueue?: Array<{ msg: unknown; adapter: unknown }> })._recoveryQueue;
  if (!queue?.length || !ctx.pipelineDeps) return;

  const pipelineDeps = ctx.pipelineDeps;
  const { handleInboundMessage } = await import("../components/message-pipeline.js");

  logInfo(TAG, `Draining ${queue.length} queued message(s) from recovery handler`);
  for (const { msg, adapter } of queue) {
    handleInboundMessage(msg as never, adapter as never, pipelineDeps)
      .catch(err => logWarn(TAG, `Drain error: ${err}`));
  }
  queue.length = 0;
}
