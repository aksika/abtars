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
};

export type TransportConfig = {
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

/** Bridge configuration loaded from .env and validated at startup. */
export type Config = {
  mainChatId: string;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  transport: TransportConfig;
  voice: VoiceConfig;
  logLevel: LogLevel;
  mcpDaemon: boolean;
};

/** Default values for optional config fields. */
export const CONFIG_DEFAULTS = {
  transport: {
    agentCliPath: "kiro-cli",
    workingDir: "~/.abtars/workspace",
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
  },
  voice: {
    sttEnabled: false,
    groqApiKey: "",
    sttModel: "whisper-large-v3",
    ttsEnabled: true,
    ttsVoice: "en-US-AndrewMultilingualNeural",
  },
  logLevel: "low" as LogLevel,
  mcpDaemon: false,
} as const;
