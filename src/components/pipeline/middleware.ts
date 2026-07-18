/**
 * Message pipeline middleware system.
 *
 * Each middleware receives a MessageContext and a next() function.
 * Call next() to continue the pipeline, or return early to short-circuit.
 * Middleware can modify ctx before/after calling next().
 */

import type { PlatformAdapter, InboundMessage } from "../../types/platform.js";
import type { PipelineDeps } from "../message-pipeline.js";
import type { IKiroTransport } from "../transport/kiro-transport.js";
import type { Reply } from "../commands/types.js";
import { sanitizeOutbound } from "../sanitize-outbound.js";

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
  /** Set to true when a specific deferred-command reply has fired — busy-guard skips its generic queue notification. */
  deferReply?: boolean;
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
  /** Resolved transport for this message (defaults to deps.transport, overridden by Spin per-user). */
  transport: IKiroTransport;
  /** Delivery mode for this session. */
  delivery: "streaming" | "simple";
  /** #1336: Validated effective session — set by session-selection middleware. */
  session?: import("../spin-types.js").ManagedSession;
  /** #1336: Validated effective session ID — set by session-selection middleware. */
  sessionId?: string;
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
  const reply: Reply = (text, opts) => {
    const clean = sanitizeOutbound(text);
    if (!clean) return Promise.resolve(undefined);
    return adapter.sendMessage(msg.channelId, clean, { threadId: msg.threadId, ...opts });
  };
  const chatId = parseInt(msg.channelId, 10) || 0;
  const userId = msg.userId;
  return {
    msg,
    adapter,
    deps,
    text: msg.text,
    chatId,
    userId,
    reply,
    handled: false,
    transport: deps.transport,
    delivery: "streaming",
  };
}
