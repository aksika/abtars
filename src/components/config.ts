import { access, stat, constants } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { type Config, type AgentTransport, CONFIG_DEFAULTS } from "../types/index.js";
import { loadUsers } from "./user-registry.js";
import { parseBoolEnv, parseNumberEnv } from "./env-utils.js";
import { readEnv } from "./env.js";
import { getEnv } from "./env-schema.js";
import { logWarn } from "./logger.js";
import type { LogLevel } from "./logger.js";
export { agentBridgeHome } from "../paths.js";

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

/**
 * Parse a comma-separated string of user IDs into a Set of numbers.
 * Trims whitespace, ignores empty segments and non-numeric values.
 */

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
export async function loadAndValidateConfig(
  platforms: { telegram: boolean; discord: boolean } = { telegram: true, discord: false },
): Promise<Config> {
  // Env is loaded by src/boot/env.ts (imported first in main.ts). By the time
  // this function runs, `.env` + `.env.skills` + `./.env` are already merged
  // into process.env with process.env precedence preserved.

  // Load transport.json + models.json (replaces transport profile .env files)
  const { loadTransport, validateAtStartup } = await import("./transport-config.js");
  const tc = loadTransport();
  if (tc) {
    validateAtStartup();
  } else {
    logWarn("config", "transport.json not loaded — using .env defaults");
  }

  // --- TELEGRAM_BOT_TOKEN (required only if telegram platform requested) ---
  const token = getEnv().telegramBotToken ?? "";
  if (platforms.telegram && !BOT_TOKEN_REGEX.test(token)) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is missing or invalid — expected format: <numeric_id>:<alphanumeric_secret>",
    );
  }

  // --- User IDs (from users.json, fallback to MAIN_CHAT_ID) ---
  const registry = loadUsers();
  const mainChatId = getEnv().mainChatId;

  // Collect IDs from whichever platform is active
  const telegramIds = registry.users
    .filter(u => u.platforms.telegram)
    .map(u => u.platforms.telegram!);
  if (mainChatId && platforms.telegram) telegramIds.push(parseInt(mainChatId, 10));
  const allowedUserIds = new Set(telegramIds.filter(id => id > 0));

  const discordIds = registry.users
    .filter(u => u.platforms.discord)
    .map(u => u.platforms.discord!);

  if (allowedUserIds.size === 0 && discordIds.length === 0 && (platforms.telegram || platforms.discord)) {
    throw new Error(
      "No users configured — create config/users.json or set MAIN_CHAT_ID",
    );
  }

  // --- AGENT_CLI_PATH ---
  const agentCli = getEnv().agentCli;
  const defaultCliPath = agentCli === "gemini" ? "gemini" : agentCli === "kiro" ? "kiro-cli" : agentCli;
  const agentCliPath = getEnv().agentCliPath || defaultCliPath;
  try {
    await validateCliPath(agentCliPath);
  } catch {
    throw new Error(`CLI binary "${agentCliPath}" is not accessible or not executable`);
  }

  // --- AGENT_TRANSPORT ---
  const rawTransport = getEnv().agentTransport;
  if (rawTransport !== "tmux" && rawTransport !== "acp" && rawTransport !== "api") {
    throw new Error(`AGENT_TRANSPORT must be "tmux", "acp", or "api", got "${rawTransport}"`);
  }
  const agentTransport = rawTransport as AgentTransport;

  // --- WORKING_DIR (optional, default cwd) ---
  let workingDir = getEnv().workingDir;
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
  const tmuxSession = getEnv().tmuxSession;

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
  const rawLogLevel = getEnv().logLevel;
  if (rawLogLevel !== "off" && rawLogLevel !== "low" && rawLogLevel !== "debug") {
    throw new Error(`LOG_LEVEL must be "off", "low", or "debug", got "${rawLogLevel}"`);
  }
  const logLevel = rawLogLevel as LogLevel;

  // --- GROQ_API_KEY (optional, enables STT) ---
  const groqApiKey = readEnv("GROQ_API_KEY", "STT/voice notes disabled") ?? "";
  const sttEnabled = parseBoolEnv("STT_ENABLED", groqApiKey.length > 0);
  const sttModel = getEnv().sttModel;

  // --- TTS (optional, default enabled) ---
  const ttsEnabled = parseBoolEnv("TTS_ENABLED", CONFIG_DEFAULTS.voice.ttsEnabled);
  const ttsVoice = getEnv().ttsVoice;

  // --- DISCORD_BOT_TOKEN (optional — Discord disabled if absent) ---
  const discordBotToken = getEnv().discordBotToken;
  const discordEnabled = !!discordBotToken;

  let discordAppId: string | undefined;
  let discordAllowedUserIds: Set<string> | undefined;

  if (discordEnabled) {
    // --- DISCORD_APP_ID (required when Discord enabled) ---
    const rawAppId = getEnv().discordAppId;
    if (!rawAppId || !isValidSnowflake(rawAppId)) {
      throw new Error(
        "DISCORD_APP_ID is required and must be a valid Discord snowflake ID (17–20 digits) when DISCORD_BOT_TOKEN is set",
      );
    }
    discordAppId = rawAppId;
    // Discord user IDs from users.json
    const discordUsers = registry.users.filter(u => u.platforms.discord);
    discordAllowedUserIds = new Set(discordUsers.map(u => u.platforms.discord!));
    if (discordAllowedUserIds.size === 0) {
      throw new Error(
        "No Discord users in users.json — add at least one user with platforms.discord",
      );
    }
  }

  // --- DISCORD_A2A_CHANNEL_ID (optional) ---
  const rawA2aChannelId = getEnv().discordA2aChannelId;
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
  const rawPeerBotId = getEnv().discordA2aPeerBotId;
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

  const resolvedMainChatId = mainChatId ?? String([...allowedUserIds][0] ?? "");

  return {
    mainChatId: resolvedMainChatId,
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
    logLevel,
    mcpDaemon: parseBoolEnv("MCPORTER_DAEMON", CONFIG_DEFAULTS.mcpDaemon),
  };
}
