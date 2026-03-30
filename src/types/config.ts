import type { LogLevel } from "../components/logger.js";

/** Transport method for communicating with the agent CLI. */
export type AgentTransport = "tmux" | "acp";

/** Bridge configuration loaded from .env and validated at startup. */
export type Config = {
  /** Telegram bot token (format: \d+:[A-Za-z0-9_-]+) */
  telegramBotToken: string;
  /** Set of allowed Telegram user IDs (non-empty, fail-closed) */
  allowedUserIds: Set<number>;
  /** Which CLI to use: "kiro" (default), "gemini", or path to any ACP-compatible CLI */
  agentCli: string;
  /** Path to CLI binary (auto-detected from agentCli if not set) */
  agentCliPath: string;
  /** Working directory for agent sessions */
  workingDir: string;
  /** Auto-approve all permission requests */
  trustMode: boolean;
  /** Timeout for interactive permission prompts in ms */
  permissionTimeoutMs: number;
  /** Telegram long-poll timeout in seconds */
  pollTimeoutS: number;
  /** Transport method: "acp" (default) or "tmux" */
  agentTransport: AgentTransport;
  /** tmux session name (only used when transport=tmux) */
  tmuxSession: string;
  /** Seconds to wait after sending a command before capturing output */
  tmuxCaptureDelaySec: number;
  /** Max seconds to poll for agent to finish responding */
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
  /** Dedicated A2A Discord channel ID */
  discordA2aChannelId?: string;
  /** Molty's bot user ID for A2A communication */
  discordA2aPeerBotId?: string;
  /** Min ms between outbound A2A messages (default: 5000) */
  discordA2aRateLimitMs: number;
  /** Whether Discord features are enabled (derived: true if discordBotToken is set) */
  discordEnabled: boolean;
  /** Whether A2A features are enabled (derived: true if discordA2aChannelId is set) */
  discordA2aEnabled: boolean;
  /** Main conversation model */
  agentModel: string;
  /** Browse subagent model */
  agentBrowseModel: string;
  /** Sleep/memory subagent model */
  agentSleepModel: string;
  /** Coding subagent model */
  agentCodingModel: string;
  /** Whether to start mcporter MCP daemon (default: false) */
  mcpDaemon: boolean;
};

/** Default values for optional config fields. */
export const CONFIG_DEFAULTS = {
  agentCli: "kiro",
  agentCliPath: "kiro-cli",
  agentTransport: "acp" as AgentTransport,
  agentModel: "claude-sonnet-4.6",
  agentBrowseModel: "claude-sonnet-4.6",
  agentSleepModel: "claude-opus-4.6",
  agentCodingModel: "claude-opus-4.6",
  workingDir: process.cwd(),
  trustMode: false,
  permissionTimeoutMs: 60_000,
  pollTimeoutS: 30,
  tmuxSession: "kiro-bridge",
  tmuxCaptureDelaySec: 3,
  tmuxMaxWaitSec: 300,
  logLevel: "low" as LogLevel,
  sttEnabled: false,
  groqApiKey: "",
  sttModel: "whisper-large-v3",
  ttsEnabled: true,
  ttsVoice: "en-US-AndrewMultilingualNeural",
  discordA2aRateLimitMs: 5000,
  discordEnabled: false,
  discordA2aEnabled: false,
  mcpDaemon: false,
} as const satisfies Partial<Config>;
