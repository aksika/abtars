/**
 * Message pipeline middleware system.
 *
 * Each middleware receives a MessageContext and a next() function.
 * Call next() to continue the pipeline, or return early to short-circuit.
 * Middleware can modify ctx before/after calling next().
 */

import type { PlatformAdapter, InboundMessage } from "../../types/platform.js";
import type { PipelineDeps } from "../message-pipeline.js";
import { loadUsers } from "../user-registry.js";
import type { Reply } from "../command-handlers.js";

/** Mutable context flowing through the middleware pipeline. */
export interface MessageContext {
  readonly msg: InboundMessage;
  readonly adapter: PlatformAdapter;
  readonly deps: PipelineDeps;
  /** Current text (may be modified by voice transcription). */
  text: string;
  /** Chat ID parsed from channelId. */
  readonly chatId: number;
  /** User ID resolved from user registry. */
  readonly userId: string;
  /** Reply helper bound to the message's channel/thread. */
  readonly reply: Reply;
  /** Set to true by any middleware that fully handled the message. */
  handled: boolean;
  /** Response from transport (set by transport middleware). */
  response?: string;
  /** Clean answer extracted from response. */
  cleanAnswer?: string;
  /** ID of the last sent message (for reactions, memory recording). */
  lastSentMsgId?: number;
  /** Whether intermediate streaming already delivered content. */
  intermediateDelivered?: boolean;
  /** ID of the streaming message (for edit-in-place). */
  streamMsgId?: number;
}

/** A middleware function in the message pipeline. */
export type Middleware = (ctx: MessageContext, next: () => Promise<void>) => Promise<void>;

/** Run a list of middleware in order. Each calls next() to continue. */
export async function runPipeline(ctx: MessageContext, middlewares: readonly Middleware[]): Promise<void> {
  let index = 0;
  const next = async (): Promise<void> => {
    if (ctx.handled || index >= middlewares.length) return;
    const mw = middlewares[index++]!;
    await mw(ctx, next);
  };
  await next();
}

/** Create a MessageContext from an inbound message. */
export function createMessageContext(
  msg: InboundMessage,
  adapter: PlatformAdapter,
  deps: PipelineDeps,
): MessageContext {
  const reply: Reply = (text, opts) => adapter.sendMessage(msg.channelId, text, { threadId: msg.threadId, ...opts });
  const chatId = parseInt(msg.channelId, 10) || 0;
  const registry = loadUsers();
  const platformKey = `${msg.platform}:${chatId}`;
  const userId = registry.byPlatformId.get(platformKey)?.userId ?? "master";
  return {
    msg,
    adapter,
    deps,
    text: msg.text,
    chatId,
    userId,
    reply,
    handled: false,
  };
}
