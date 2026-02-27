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
} as const satisfies Partial<Config>;
