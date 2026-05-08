/** Unified platform abstraction — any messaging channel implements this. */

export type Platform = "telegram" | "discord" | (string & {});

export interface SendOpts {
  threadId?: string;
  parseMode?: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

/** Normalized inbound message from any platform. */
export interface InboundMessage {
  platform: Platform;
  channelId: string;         // raw platform channel ID
  sessionKey: string;        // "telegram:123" / "discord:456"
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
