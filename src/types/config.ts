import type { LogLevel } from "../components/logger.js";

/** Transport method for communicating with kiro-cli. */
export type KiroTransport = "tmux" | "acp";

/** Bridge configuration loaded from .env and validated at startup. */
export type Config = {
  /** Telegram bot token (format: \d+:[A-Za-z0-9_-]+) */
  telegramBotToken: string;
  /** Set of allowed Telegram user IDs (non-empty, fail-closed) */
  allowedUserIds: Set<number>;
  /** Path to kiro-cli binary */
  kiroCLIPath: string;
  /** Working directory for Kiro sessions */
  workingDir: string;
  /** Auto-approve all permission requests */
  trustMode: boolean;
  /** Timeout for interactive permission prompts in ms */
  permissionTimeoutMs: number;
  /** Telegram long-poll timeout in seconds */
  pollTimeoutS: number;
  /** Transport method: "tmux" (default) or "acp" */
  kiroTransport: KiroTransport;
  /** tmux session name (only used when transport=tmux) */
  tmuxSession: string;
  /** Seconds to wait after sending a command before capturing output */
  tmuxCaptureDelaySec: number;
  /** Max seconds to poll for Kiro to finish responding */
  tmuxMaxWaitSec: number;
  /** Log level: "off", "low", "debug" */
  logLevel: LogLevel;
  /** STT enabled (true if GROQ_API_KEY is set) */
  sttEnabled: boolean;
  /** Groq API key for Whisper STT */
  groqApiKey: string;
  /** STT model (default: whisper-large-v3) */
  sttModel: string;
  /** TTS enabled (default: true) */
  ttsEnabled: boolean;
  /** Edge TTS voice (default: en-US-AndrewMultilingualNeural) */
  ttsVoice: string;
  /** Discord Application ID (snowflake) — used for @mention detection */
  discordAppId?: string;
  /** Discord bot token (optional — Discord disabled if absent) */
  discordBotToken?: string;
  /** Set of allowed Discord user IDs (snowflake strings) */
  discordAllowedUserIds?: Set<string>;
  /** Set of allowed Discord channel IDs (snowflake strings) */
  discordAllowedChannelIds?: Set<string>;
  /** Dedicated B2B Discord channel ID */
  discordB2bChannelId?: string;
  /** Molty's bot user ID for B2B communication */
  discordB2bPeerBotId?: string;
  /** Min ms between outbound B2B messages (default: 5000) */
  discordB2bRateLimitMs: number;
  /** Whether Discord features are enabled (derived: true if discordBotToken is set) */
  discordEnabled: boolean;
  /** Whether B2B features are enabled (derived: true if discordB2bChannelId is set) */
  discordB2bEnabled: boolean;
};

/** Default values for optional config fields. */
export const CONFIG_DEFAULTS = {
  kiroCLIPath: "kiro-cli",
  workingDir: process.cwd(),
  trustMode: false,
  permissionTimeoutMs: 60_000,
  pollTimeoutS: 30,
  kiroTransport: "tmux" as KiroTransport,
  tmuxSession: "kiro-bridge",
  tmuxCaptureDelaySec: 3,
  tmuxMaxWaitSec: 300,
  logLevel: "low" as LogLevel,
  sttEnabled: false,
  groqApiKey: "",
  sttModel: "whisper-large-v3",
  ttsEnabled: true,
  ttsVoice: "en-US-AndrewMultilingualNeural",
  discordB2bRateLimitMs: 5000,
  discordEnabled: false,
  discordB2bEnabled: false,
} as const satisfies Partial<Config>;
