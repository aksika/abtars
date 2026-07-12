/** Unified platform abstraction — any messaging channel implements this. */

export type Platform = "telegram" | "discord" | (string & {});

/** #1397: Internal delivery correlation — not serialized to external platforms. */
export interface DeliveryCorrelation {
  sessionId: string;
  executionId: string;
  kind: "final_assistant" | "system" | "tool_status" | "error";
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
  /** Set to false to disable intermediate streaming (IRC — no edit-in-place, no per-chunk delivery). */
  supportsStreaming?: boolean;
  sendTyping?(channelId: string, threadId?: string): Promise<void>;
  editMessage?(channelId: string, messageId: number | string, text: string): Promise<void>;
  setReaction?(channelId: string, messageId: number | string, emoji: string): Promise<void>;
  downloadVoice?(fileId: string): Promise<Buffer>;
  sendVoice?(channelId: string, audio: Buffer, opts?: SendOpts): Promise<void>;

  // Re-inject a queued message after sleep wake-up
  injectMessage?(msg: InboundMessage): void;
}
