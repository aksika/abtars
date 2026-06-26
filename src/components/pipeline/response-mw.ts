/**
 * response-mw.ts — Response delivery. One path for ALL response types.
 * Key invariant: messageCount ALWAYS increments on successful delivery.
 */

import type { PlatformAdapter, InboundMessage } from "../../types/platform.js";
import type { ManagedSession } from "../spin-types.js";
import { cleanResponse } from "../clean-response.js";
import { logDebug, logInfo, logWarn } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { updateBridgeLockField } from "../transport/bridge-lock-transport.js";

const TAG = "response-mw";

export interface DeliveryContext {
  rawResponse: string;
  fullMode: boolean;
  cleanAnswer: string | undefined;
  session: ManagedSession;
  adapter: PlatformAdapter;
  msg: InboundMessage;
  channelId: string;
  transport: { contextPercent: number; toolCallsSucceeded: number };
  retrySend: (fn: () => Promise<any>) => Promise<any>;
}

export interface DeliveryResult {
  delivered: boolean;
  userResponse: string;
  lastSentMsgId?: number | string;
  topics?: string[];
}

/**
 * Deliver a response to the user. Handles all response types:
 * - Normal text → chunk + sendMessage
 * - Emoji-only → sendMessage (no special path)
 * - [REACT:emoji] + text → send text + set reaction
 * - Empty + noReply → drop silently
 * - Empty + tool calls → suppress
 * - Empty → error message
 *
 * ALWAYS increments messageCount on successful delivery.
 */
export async function deliverResponse(ctx: DeliveryContext): Promise<DeliveryResult> {
  const { session, adapter, msg, channelId, transport, retrySend } = ctx;
  const rawResponse = ctx.fullMode ? ctx.rawResponse : (ctx.cleanAnswer || ctx.rawResponse);
  const { text: cleanedText, reactionEmoji, noReply, topics } = cleanResponse(rawResponse);
  let userResponse = cleanedText;

  // Strip <think>/<thinking> blocks + orphaned closing tags
  userResponse = userResponse.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/g, "");
  userResponse = userResponse.replace(/<\/think(?:ing)?>\s*/g, "");

  // Secret redaction
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith("SECRET_") && val && userResponse.includes(val)) {
      userResponse = userResponse.replaceAll(val, `[REDACTED:$${key}]`);
      logWarn(TAG, `Redacted leaked secret $${key} from response`);
    }
  }

  // Empty + reactionEmoji → treat emoji as the response
  if (!userResponse && reactionEmoji) {
    userResponse = reactionEmoji;
  }

  // Empty response handling
  if (!userResponse) {
    if (noReply) {
      logDebug(TAG, "LLM returned [NO_REPLY], dropping silently");
      return { delivered: false, userResponse: "" };
    }
    if (transport.toolCallsSucceeded > 0) {
      logDebug(TAG, `Empty text but ${transport.toolCallsSucceeded} tool call(s) succeeded — suppressing fallback`);
      if (adapter.setReaction && msg.messageId) await adapter.setReaction(channelId, msg.messageId, "").catch(err => logAndSwallow(TAG, "adapter call", err));
    } else {
      logWarn(TAG, "Empty response from transport");
      await adapter.sendMessage(channelId, "x Model returned an empty response. Try again or /reset.", { threadId: msg.threadId });
    }
    return { delivered: false, userResponse: "" };
  }

  // Clear 👀 reaction
  if (adapter.setReaction && msg.messageId) {
    await adapter.setReaction(channelId, msg.messageId, "").catch(err => logAndSwallow(TAG, "adapter call", err));
  }

  // Deliver — chunk and send
  let lastSentMsgId: number | string | undefined;
  const chunks = adapter.chunkResponse(userResponse);
  logDebug(TAG, `Sending ${chunks.length} chunk(s)`);
  for (const chunk of chunks) {
    const clean = chunk.replace(/\[TOPICS:\s*.+?\]/gi, "").replace(/\[REACT:.+?\]/gi, "").trim();
    if (clean) {
      await adapter.sendTyping?.(channelId, msg.threadId);
      lastSentMsgId = await retrySend(() => adapter.sendMessage(channelId, clean, { threadId: msg.threadId }));
    }
  }

  // Reaction emoji (alongside text)
  if (reactionEmoji) {
    if (adapter.setReaction && msg.messageId) {
      try { await adapter.setReaction(channelId, msg.messageId, reactionEmoji); }
      catch { await adapter.sendMessage(channelId, reactionEmoji, { threadId: msg.threadId }); }
    } else {
      await adapter.sendMessage(channelId, reactionEmoji, { threadId: msg.threadId });
    }
  }

  const ctxAfter = transport.contextPercent;
  logInfo(TAG, `→ [${msg.platform}] Response delivered${ctxAfter >= 0 ? ` (ctx: ${ctxAfter}%)` : ""}`);
  updateBridgeLockField("lastPromptAt", Date.now());

  // ALWAYS increment metrics
  session.messageCount = (session.messageCount ?? 0) + 1;
  session.contextPercent = ctxAfter >= 0 ? ctxAfter : undefined;
  session.toolCallCount = (session.toolCallCount ?? 0) + (transport.toolCallsSucceeded ?? 0);

  return { delivered: true, userResponse, lastSentMsgId, topics };
}
