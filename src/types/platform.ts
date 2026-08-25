/** Unified platform abstraction — any messaging channel implements this. */

export type Platform = "telegram" | "discord" | (string & {});

/** #1397: Internal delivery correlation — not serialized to external platforms. */
export interface DeliveryCorrelation {
  sessionId: string;
  executionId: string;
  kind: "final_assistant" | "system" | "tool_status" | "error";
}

/** #1515: bounded question attached to the automatic boot greeting. Never
 *  enters provider input; only Spin's automatic boot injection creates it. */
export interface BootGreetingQuestion {
  id: string;
  text: string;
}

/** #1515: trusted internal boot metadata. Only Spin's automatic master boot
 *  injection may construct it; external platform/TUI/API adapters never read
 *  an inbound `internal` property and never populate it. */
export const BOOT_GREETING_TOKEN: unique symbol = Symbol("abtars.boot-greeting");
export interface InternalBootMetadata {
  /** Runtime-only provenance marker; never serialized to an adapter. */
  readonly [BOOT_GREETING_TOKEN]?: true;
  kind: "boot_greeting";
  dreamQuestion?: BootGreetingQuestion;
}

/**
 * #1724: delivery outcome of a receipt-bearing internal submission.
 * `sent` means every response chunk was externally delivered; `not_sent`
 * means definitely nothing reached the platform (rejected admission,
 * empty/no-reply turn, failed first chunk); `unknown` means a partial or
 * ambiguous send — never automatically resent.
 */
export type MainDeliveryResult = "sent" | "not_sent" | "unknown";

/** #1724: trusted internal scheduled-announcement metadata. Only the local
 *  MainConversationIngress may construct it; external platform/TUI/API
 *  adapters never read an inbound `internal` property and never populate it.
 *  The event ID (`scheduled-card:<cardId>`) is derived from the durable Kanban
 *  card and doubles as the inbound durable-operation identity, so retries
 *  deduplicate instead of re-recording the announcement. */
export const SCHEDULED_ANNOUNCEMENT_TOKEN: unique symbol = Symbol("abtars.scheduled-announcement");
export interface InternalScheduledAnnouncementMetadata {
  /** Runtime-only provenance marker; never serialized to an adapter. */
  readonly [SCHEDULED_ANNOUNCEMENT_TOKEN]?: true;
  kind: "scheduled_announcement";
  eventId: string;
  cardId: number;
}

export interface SendOpts {
  threadId?: string;
  parseMode?: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  /** #1397: Internal execution correlation for stream-suppression decisions.
   *  Set only on final assistant delivery. Other adapters ignore it. */
  deliveryCorrelation?: DeliveryCorrelation;
}

/** Normalized inbound message from any platform. */
export interface InboundMessage {
  platform: Platform;
  channelId: string;         // raw platform channel ID
  userId: string;            // resolved from users.json (e.g. "aksika")
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  threadId?: string;
  messageId?: number | string;
  isGroup: boolean;
  isVoice: boolean;
  voiceFileId?: string;      // platform file ID for voice download
  mediaPath?: string;         // path to saved media file on disk
  rawPlatformData?: unknown;
  /** #1336: Internal routing hint — only TuiSocketAdapter sets it. Untrusted routing request. */
  targetSessionId?: string;
  /** #1515: trusted internal boot metadata — set ONLY by Spin's automatic boot
   *  injection. #1724: or by the trusted MainConversationIngress for scheduled
   *  announcements. External adapters never construct it. */
  internal?: InternalBootMetadata | InternalScheduledAnnouncementMetadata;
}

/** What a platform adapter can do — pipeline checks these. */
export interface PlatformCapabilities {
  voice: boolean;
  reactions: boolean;
  typing: boolean;
  threads: boolean;
}

/**
 * Contract every messaging platform must implement.
 * The message pipeline calls these methods — platform-specific
 * details stay inside the adapter.
 */
export interface PlatformAdapter {
  readonly name: Platform;
  readonly capabilities: PlatformCapabilities;

  // Lifecycle
  start(): Promise<void>;
  stop(): void;

  // Security
  authorize(msg: InboundMessage): boolean;

  // Messaging
  sendMessage(channelId: string, text: string, opts?: SendOpts): Promise<number | string | undefined>;
  chunkResponse(text: string): string[];

  // Optional capabilities
  /** Set to false to disable intermediate streaming. */
  supportsStreaming?: boolean;
  sendTyping?(channelId: string, threadId?: string): Promise<void>;
  editMessage?(channelId: string, messageId: number | string, text: string): Promise<void>;
  setReaction?(channelId: string, messageId: number | string, emoji: string): Promise<void>;
  downloadVoice?(fileId: string): Promise<Buffer>;
  sendVoice?(channelId: string, audio: Buffer, opts?: SendOpts): Promise<void>;

  // Re-inject a queued message after sleep wake-up
  injectMessage?(msg: InboundMessage): void;
}
