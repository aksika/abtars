import type { LogLevel } from "../components/logger.js";

/** Transport method for communicating with the agent CLI. */
export type AgentTransport = "tmux" | "acp" | "api";

export type TelegramConfig = {
  botToken: string;
  allowedUserIds: Set<number>;
  pollTimeoutS: number;
};

export type DiscordConfig = {
  enabled: boolean;
  botToken?: string;
  appId?: string;
  allowedUserIds?: Set<string>;
  allowedChannelIds?: Set<string>;
  a2aEnabled: boolean;
  a2aChannelId?: string;
  a2aPeerBotId?: string;
  a2aRateLimitMs: number;
};

export type TransportConfig = {
  agentTransport: AgentTransport;
  agentCli: string;
  agentCliPath: string;
  workingDir: string;
  trustMode: boolean;
  permissionTimeoutMs: number;
  tmuxSession: string;
  tmuxCaptureDelaySec: number;
  tmuxMaxWaitSec: number;
};

export type VoiceConfig = {
  sttEnabled: boolean;
  groqApiKey: string;
  sttModel: string;
  ttsEnabled: boolean;
  ttsVoice: string;
};

export type ModelConfig = {
  agentModel: string;
  browseModel: string;
  sleepModel: string;
  codingModel: string;
};

/** Bridge configuration loaded from .env and validated at startup. */
export type Config = {
  telegram: TelegramConfig;
  discord: DiscordConfig;
  transport: TransportConfig;
  voice: VoiceConfig;
  models: ModelConfig;
  logLevel: LogLevel;
  mcpDaemon: boolean;
};

/** Default values for optional config fields. */
export const CONFIG_DEFAULTS = {
  transport: {
    agentCli: "kiro",
    agentCliPath: "kiro-cli",
    agentTransport: "acp" as AgentTransport,
    workingDir: process.cwd(),
    trustMode: false,
    permissionTimeoutMs: 60_000,
    tmuxSession: "kiro-bridge",
    tmuxCaptureDelaySec: 3,
    tmuxMaxWaitSec: 300,
  },
  telegram: {
    pollTimeoutS: 30,
  },
  discord: {
    enabled: false,
    a2aEnabled: false,
    a2aRateLimitMs: 5000,
  },
  voice: {
    sttEnabled: false,
    groqApiKey: "",
    sttModel: "whisper-large-v3",
    ttsEnabled: true,
    ttsVoice: "en-US-AndrewMultilingualNeural",
  },
  models: {
    agentModel: "claude-sonnet-4.6",
    browseModel: "claude-sonnet-4.6",
    sleepModel: "claude-opus-4.6",
    codingModel: "claude-opus-4.6",
  },
  logLevel: "low" as LogLevel,
  mcpDaemon: false,
} as const;
