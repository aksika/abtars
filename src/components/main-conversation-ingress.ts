/**
 * main-conversation-ingress.ts — #1724: trusted synthetic Main turns for
 * scheduled announcements.
 *
 * Main is the authoritative conversational owner of every substantive
 * user-facing message. A scheduled one-shot T result is an internal handoff
 * payload, not a user-facing message: this boundary submits it to the target
 * user's general A session through the normal message pipeline, so Main (not
 * the delivery poll) composes and delivers the announcement, and both the
 * internal event and Main's response land in the durable conversation record.
 *
 * Trust model: the request can only be constructed by boot-composed local
 * code (the Kanban delivery closure). External platform input never reaches
 * this class and can never forge `msg.internal`, because adapters never
 * populate that property.
 */

import { SCHEDULED_ANNOUNCEMENT_TOKEN } from "../types/platform.js";
import type {
  InboundMessage,
  MainDeliveryResult,
  PlatformAdapter,
} from "../types/platform.js";
import type { PipelineDeps } from "./message-pipeline.js";
import { submitTrustedInternalMessage } from "./message-pipeline.js";
import { logWarn } from "./logger.js";

const TAG = "main-ingress";

/** #1724: one trusted scheduled-announcement handoff into Main. */
export interface MainAnnouncementRequest {
  /** Durable, card-derived identity (`scheduled-card:<cardId>`). Doubles as
   *  the inbound durable-operation key, so delivery retries deduplicate. */
  eventId: string;
  cardId: number;
  title: string;
  userId: string;
  platform: string;
  chatId: string;
  threadId?: string;
  /** Already redacted and bounded by task settlement (#1610). */
  result: string;
}

/** Dependencies resolved lazily at delivery time — adapters and pipeline deps
 *  are composed by later boot phases than the heartbeat registration. */
export interface MainConversationIngressDeps {
  getPipelineDeps: () => PipelineDeps | null;
  getAdapter: (platform: string) => PlatformAdapter | null | undefined;
}

/** The stable, delimited synthetic-event text Main receives. */
export function composeScheduledAnnouncementText(
  title: string,
  cardId: number,
  result: string,
): string {
  return [
    "[SCHEDULED TASK COMPLETED]",
    `Task: ${title}`,
    `Card ID: ${cardId}`,
    "",
    "The task agent produced the following user-facing result:",
    result,
    "",
    "Announce this result to the user in your own words. Do not invent additional task results and do not use platform-delivery tools.",
  ].join("\n");
}

export class MainConversationIngress {
  private readonly deps: MainConversationIngressDeps;

  constructor(deps: MainConversationIngressDeps) {
    this.deps = deps;
  }

  /**
   * Submit one scheduled announcement to Main's general conversation and wait
   * for a definite external delivery outcome. Never throws — every failure
   * mode maps to "not_sent"; the caller's existing retry/unknown state
   * machine owns what happens next. There is no direct-platform fallback.
   */
  async announceToMain(request: MainAnnouncementRequest): Promise<MainDeliveryResult> {
    const pipelineDeps = this.deps.getPipelineDeps();
    if (!pipelineDeps) {
      logWarn(TAG, `Pipeline unavailable for ${request.eventId} — not sent`);
      return "not_sent";
    }
    const trimmed = request.result.trim();
    if (
      !request.eventId
      || !Number.isFinite(request.cardId)
      || !request.userId
      || !request.platform
      || !request.chatId
      || !request.title
      || !trimmed
    ) {
      // An empty result must never be announced as a success-shaped turn.
      logWarn(TAG, `Rejected malformed announcement ${request.eventId} — not sent`);
      return "not_sent";
    }
    const adapter = this.deps.getAdapter(request.platform);
    if (!adapter) {
      logWarn(TAG, `No ${request.platform} adapter for ${request.eventId} — not sent`);
      return "not_sent";
    }

    // Defense-in-depth target validation before submission; the session-
    // selection middleware re-validates the same predicate on the pipeline
    // path (busy/paused rejection happens there too).
    const { spin } = await import("./spin.js");
    const { sessionTypeOf } = await import("./spin-types.js");
    const session = spin.getActiveSession(request.userId, request.platform);
    if (
      session.userId !== request.userId
      || sessionTypeOf(session.id) !== "A"
      || session.status === "ended"
      || String(session.chatId) !== request.chatId
    ) {
      logWarn(TAG, `Target A session unavailable/mismatched for ${request.eventId} — not sent`);
      return "not_sent";
    }

    const msg: InboundMessage = {
      platform: request.platform,
      channelId: request.chatId,
      userId: request.userId,
      senderId: "scheduler",
      senderName: "scheduler",
      text: composeScheduledAnnouncementText(request.title, request.cardId, trimmed),
      timestamp: Date.now(),
      ...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
      isGroup: false,
      isVoice: false,
      internal: {
        [SCHEDULED_ANNOUNCEMENT_TOKEN]: true,
        kind: "scheduled_announcement",
        eventId: request.eventId,
        cardId: request.cardId,
      },
    };
    return submitTrustedInternalMessage(msg, adapter, pipelineDeps);
  }
}
