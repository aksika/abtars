import { access, stat, constants } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { config as loadDotenv } from "dotenv";
import { type Config, type AgentTransport, CONFIG_DEFAULTS } from "../types/index.js";
import { parseBoolEnv, parseNumberEnv } from "./env-utils.js";
import { logInfo } from "./logger.js";
import type { LogLevel } from "./logger.js";
export { agentBridgeHome } from "../paths.js";
import { agentBridgeHome } from "../paths.js";

const BOT_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]+$/;
const SNOWFLAKE_REGEX = /^\d{17,20}$/;

/**
 * Validate that a string is a valid Discord snowflake ID (17–20 digits).
 */
export function isValidSnowflake(value: string): boolean {
  return SNOWFLAKE_REGEX.test(value);
}

/**
 * Parse a comma-separated string of Discord snowflake IDs into a Set.
 * Trims whitespace and ignores empty segments.
 * Throws if any non-empty segment is not a valid snowflake.
 */
function parseSnowflakeList(raw: string, envVarName: string): Set<string> {
  const ids = new Set<string>();
  for (const segment of raw.split(",")) {
    const trimmed = segment.trim();
    if (trimmed === "") continue;
    if (!isValidSnowflake(trimmed)) {
      throw new Error(
        `${envVarName} contains invalid Discord snowflake ID "${trimmed}" — expected 17–20 digits`,
      );
    }
    ids.add(trimmed);
  }
  return ids;
}

/**
 * Parse a comma-separated string of user IDs into a Set of numbers.
 * Trims whitespace, ignores empty segments and non-numeric values.
 */
function parseUserIds(raw: string): Set<number> {
  const ids = new Set<number>();
  for (const segment of raw.split(",")) {
    const trimmed = segment.trim();
    if (trimmed === "") continue;
    const n = Number(trimmed);
    if (Number.isFinite(n) && Number.isInteger(n)) {
      ids.add(n);
    }
  }
  return ids;
}

/**
 * Check whether the kiro-cli path is executable.
 * On Windows, skip the X_OK check — just verify the path exists or treat
 * bare command names (no path separator) as valid.
 */
async function validateCliPath(cliPath: string): Promise<void> {
  const isWindows = process.platform === "win32";
  const isBareCommand = !cliPath.includes("/") && !cliPath.includes("\\");

  // Bare command names (e.g. "kiro-cli") rely on PATH resolution at runtime.
  // We can't reliably check those with fs.access, so accept them as-is.
  if (isBareCommand) return;

  if (isWindows) {
    // On Windows just verify the file exists (no X_OK support).
    await access(cliPath, constants.F_OK);
  } else {
    await access(cliPath, constants.X_OK);
  }
}

/**
 * Load configuration from `process.env`, validate every field, and return a
 * typed `Config` object. Throws with a descriptive message on any failure.
 *
 * Env-file loading is the caller's responsibility (dotenv or `--env-file`).
 */
export async function loadAndValidateConfig(): Promise<Config> {
  // Load .env from ~/.agentbridge/.env
  const envPath = resolve(agentBridgeHome(), ".env");
  loadDotenv({ path: envPath });

  // Load .env.local (local-only overrides — HA_, TOGETHERAI_, custom integrations)
  const localEnvPath = resolve(agentBridgeHome(), ".env.local");
  loadDotenv({ path: localEnvPath, override: true });

  // Load transport profile (e.g. transports/kiro.env) — overrides AGENT_* vars
  const transportProfile = process.env["AGENT_TRANSPORT_PROFILE"];
  if (transportProfile) {
    const profilePath = resolve(agentBridgeHome(), "transports", `${transportProfile}.env`);
    loadDotenv({ path: profilePath, override: true });
    logInfo("config", `Loaded transport profile: ${transportProfile}`);
  }

  // --- TELEGRAM_BOT_TOKEN (required) ---
  const token = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
  if (!BOT_TOKEN_REGEX.test(token)) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is missing or invalid — expected format: <numeric_id>:<alphanumeric_secret>",
    );
  }

  // --- ALLOWED_USER_IDS (required, at least one numeric ID) ---
  const rawUserIds = process.env["ALLOWED_USER_IDS"] ?? "";
  const allowedUserIds = parseUserIds(rawUserIds);
  if (allowedUserIds.size === 0) {
    throw new Error(
      "ALLOWED_USER_IDS is missing or contains no valid numeric IDs — provide at least one comma-separated user ID",
    );
  }

  // --- AGENT_CLI_PATH ---
  const agentCli = process.env["AGENT_CLI"] || CONFIG_DEFAULTS.transport.agentCli;
  const defaultCliPath = agentCli === "gemini" ? "gemini" : agentCli === "kiro" ? "kiro-cli" : agentCli;
  const agentCliPath = process.env["AGENT_CLI_PATH"] || defaultCliPath;
  try {
    await validateCliPath(agentCliPath);
  } catch {
    throw new Error(`CLI binary "${agentCliPath}" is not accessible or not executable`);
  }

  // --- AGENT_TRANSPORT ---
  const rawTransport = (process.env["AGENT_TRANSPORT"] || CONFIG_DEFAULTS.transport.agentTransport).toLowerCase();
  if (rawTransport !== "tmux" && rawTransport !== "acp" && rawTransport !== "api") {
    throw new Error(`AGENT_TRANSPORT must be "tmux", "acp", or "api", got "${rawTransport}"`);
  }
  const agentTransport = rawTransport as AgentTransport;

  // --- AGENT_MODEL ---
  const agentModel = process.env["AGENT_MODEL"] || CONFIG_DEFAULTS.models.agentModel;

  // Sub-models default to main model if not explicitly set
  const agentBrowseModel = process.env["AGENT_BROWSE_MODEL"] || agentModel;
  const agentSleepModel = process.env["AGENT_SLEEP_MODEL"] || agentModel;
  const agentCodingModel = process.env["AGENT_CODING_MODEL"] || agentModel;

  // --- WORKING_DIR (optional, default cwd) ---
  let workingDir = process.env["WORKING_DIR"] || CONFIG_DEFAULTS.transport.workingDir;
  // Expand ~ to home directory (Node doesn't do this automatically)
  if (workingDir.startsWith("~")) {
    workingDir = resolve(homedir(), workingDir.slice(1).replace(/^[/\\]/, ""));
  }
  try {
    const info = await stat(workingDir);
    if (!info.isDirectory()) {
      throw new Error(
        `WORKING_DIR "${workingDir}" exists but is not a directory`,
      );
    }
  } catch (err) {
    // Re-throw our own descriptive error; wrap unknown fs errors.
    if (err instanceof Error && err.message.startsWith("WORKING_DIR")) {
      throw err;
    }
    throw new Error(
      `WORKING_DIR "${workingDir}" does not exist or is not accessible`,
    );
  }

  // --- TRUST_MODE (optional boolean, default false) ---
  const trustMode = parseBoolEnv(
    "TRUST_MODE",
    CONFIG_DEFAULTS.transport.trustMode,
  );

  // --- PERMISSION_TIMEOUT_MS (optional number, default 60000) ---
  const permissionTimeoutMs = parseNumberEnv(
    "PERMISSION_TIMEOUT_MS",
    CONFIG_DEFAULTS.transport.permissionTimeoutMs,
  );

  // --- POLL_TIMEOUT_S (optional number, default 30) ---
  const pollTimeoutS = parseNumberEnv(
    "POLL_TIMEOUT_S",
    CONFIG_DEFAULTS.telegram.pollTimeoutS,
  );


  // --- TMUX_SESSION (optional, default "kiro-bridge") ---
  const tmuxSession = process.env["TMUX_SESSION"] || CONFIG_DEFAULTS.transport.tmuxSession;

  // --- TMUX_CAPTURE_DELAY_SEC (optional, default 3) ---
  const tmuxCaptureDelaySec = parseNumberEnv(
    "TMUX_CAPTURE_DELAY_SEC",
    CONFIG_DEFAULTS.transport.tmuxCaptureDelaySec,
  );

  // --- TMUX_MAX_WAIT_SEC (optional, default 300) ---
  const tmuxMaxWaitSec = parseNumberEnv(
    "TMUX_MAX_WAIT_SEC",
    CONFIG_DEFAULTS.transport.tmuxMaxWaitSec,
  );

  // --- LOG_LEVEL (optional, default "low") ---
  const rawLogLevel = (process.env["LOG_LEVEL"] || CONFIG_DEFAULTS.logLevel).toLowerCase();
  if (rawLogLevel !== "off" && rawLogLevel !== "low" && rawLogLevel !== "debug") {
    throw new Error(`LOG_LEVEL must be "off", "low", or "debug", got "${rawLogLevel}"`);
  }
  const logLevel = rawLogLevel as LogLevel;

  // --- GROQ_API_KEY (optional, enables STT) ---
  const groqApiKey = process.env["GROQ_API_KEY"] ?? "";
  const sttEnabled = parseBoolEnv("STT_ENABLED", groqApiKey.length > 0);
  const sttModel = process.env["STT_MODEL"] || CONFIG_DEFAULTS.voice.sttModel;

  // --- TTS (optional, default enabled) ---
  const ttsEnabled = parseBoolEnv("TTS_ENABLED", CONFIG_DEFAULTS.voice.ttsEnabled);
  const ttsVoice = process.env["TTS_VOICE"] || CONFIG_DEFAULTS.voice.ttsVoice;

  // --- DISCORD_BOT_TOKEN (optional — Discord disabled if absent) ---
  const discordBotToken = process.env["DISCORD_BOT_TOKEN"]?.trim() || undefined;
  const discordEnabled = !!discordBotToken;

  let discordAppId: string | undefined;
  let discordAllowedUserIds: Set<string> | undefined;
  let discordAllowedChannelIds: Set<string> | undefined;

  if (discordEnabled) {
    // --- DISCORD_APP_ID (required when Discord enabled) ---
    const rawAppId = process.env["DISCORD_APP_ID"]?.trim() || undefined;
    if (!rawAppId || !isValidSnowflake(rawAppId)) {
      throw new Error(
        "DISCORD_APP_ID is required and must be a valid Discord snowflake ID (17–20 digits) when DISCORD_BOT_TOKEN is set",
      );
    }
    discordAppId = rawAppId;
    // --- DISCORD_ALLOWED_USER_IDS (required when Discord enabled) ---
    const rawDiscordUserIds = process.env["DISCORD_ALLOWED_USER_IDS"] ?? "";
    discordAllowedUserIds = parseSnowflakeList(rawDiscordUserIds, "DISCORD_ALLOWED_USER_IDS");
    if (discordAllowedUserIds.size === 0) {
      throw new Error(
        "DISCORD_ALLOWED_USER_IDS is required and must contain at least one valid Discord snowflake ID when DISCORD_BOT_TOKEN is set",
      );
    }

    // --- DISCORD_ALLOWED_CHANNEL_IDS (required when Discord enabled, "*" = all channels) ---
    const rawDiscordChannelIds = process.env["DISCORD_ALLOWED_CHANNEL_IDS"]?.trim() ?? "";
    if (rawDiscordChannelIds === "*") {
      discordAllowedChannelIds = new Set(["*"]);
    } else {
      discordAllowedChannelIds = parseSnowflakeList(rawDiscordChannelIds, "DISCORD_ALLOWED_CHANNEL_IDS");
      if (discordAllowedChannelIds.size === 0) {
        throw new Error(
          "DISCORD_ALLOWED_CHANNEL_IDS is required when DISCORD_BOT_TOKEN is set — use \"*\" for all channels or provide comma-separated snowflake IDs",
        );
      }
    }
  }

  // --- DISCORD_A2A_CHANNEL_ID (optional) ---
  const rawA2aChannelId = process.env["DISCORD_A2A_CHANNEL_ID"]?.trim() || undefined;
  let discordA2aChannelId: string | undefined;
  if (rawA2aChannelId) {
    if (!isValidSnowflake(rawA2aChannelId)) {
      throw new Error(
        `DISCORD_A2A_CHANNEL_ID "${rawA2aChannelId}" is not a valid Discord snowflake ID — expected 17–20 digits`,
      );
    }
    discordA2aChannelId = rawA2aChannelId;
  }

  // --- DISCORD_A2A_PEER_BOT_ID (required when A2A channel is set) ---
  const rawPeerBotId = process.env["DISCORD_A2A_PEER_BOT_ID"]?.trim() || undefined;
  let discordA2aPeerBotId: string | undefined;
  if (rawPeerBotId) {
    if (!isValidSnowflake(rawPeerBotId)) {
      throw new Error(
        `DISCORD_A2A_PEER_BOT_ID "${rawPeerBotId}" is not a valid Discord snowflake ID — expected 17–20 digits`,
      );
    }
    discordA2aPeerBotId = rawPeerBotId;
  }

  if (discordA2aChannelId && !discordA2aPeerBotId) {
    throw new Error(
      "DISCORD_A2A_PEER_BOT_ID is required when DISCORD_A2A_CHANNEL_ID is set",
    );
  }

  const discordA2aEnabled = !!discordA2aChannelId;

  // --- DISCORD_A2A_RATE_LIMIT_MS (optional, default 5000) ---
  const discordA2aRateLimitMs = parseNumberEnv(
    "DISCORD_A2A_RATE_LIMIT_MS",
    CONFIG_DEFAULTS.discord.a2aRateLimitMs,
  );

  return {
    telegram: {
      botToken: token,
      allowedUserIds,
      pollTimeoutS,
    },
    discord: {
      enabled: discordEnabled,
      botToken: discordBotToken,
      appId: discordAppId,
      allowedUserIds: discordAllowedUserIds,
      allowedChannelIds: discordAllowedChannelIds,
      a2aEnabled: discordA2aEnabled,
      a2aChannelId: discordA2aChannelId,
      a2aPeerBotId: discordA2aPeerBotId,
      a2aRateLimitMs: discordA2aRateLimitMs,
    },
    transport: {
      agentTransport,
      agentCli,
      agentCliPath,
      workingDir,
      trustMode,
      permissionTimeoutMs,
      tmuxSession,
      tmuxCaptureDelaySec,
      tmuxMaxWaitSec,
    },
    voice: {
      sttEnabled,
      groqApiKey,
      sttModel,
      ttsEnabled,
      ttsVoice,
    },
    models: {
      agentModel,
      browseModel: agentBrowseModel,
      sleepModel: agentSleepModel,
      codingModel: agentCodingModel,
    },
    logLevel,
    mcpDaemon: parseBoolEnv("MCPORTER_DAEMON", CONFIG_DEFAULTS.mcpDaemon),
  };
}
