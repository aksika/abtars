import { access, stat, constants } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { config as loadDotenv } from "dotenv";
import { type Config, type KiroTransport, CONFIG_DEFAULTS } from "../types/index.js";
import type { LogLevel } from "./logger.js";

/** ~/.agentbridge/ is the runtime config/data directory */
export const AGENT_BRIDGE_HOME = resolve(homedir(), ".agentbridge");

const BOT_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]+$/;

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
  const envPath = resolve(AGENT_BRIDGE_HOME, ".env");
  loadDotenv({ path: envPath });

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

  // --- KIRO_CLI_PATH (optional, default from CONFIG_DEFAULTS) ---
  const kiroCLIPath =
    process.env["KIRO_CLI_PATH"] || CONFIG_DEFAULTS.kiroCLIPath;
  try {
    await validateCliPath(kiroCLIPath);
  } catch {
    throw new Error(
      `KIRO_CLI_PATH "${kiroCLIPath}" is not accessible or not executable`,
    );
  }

  // --- WORKING_DIR (optional, default cwd) ---
  const workingDir = process.env["WORKING_DIR"] || CONFIG_DEFAULTS.workingDir;
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
  const trustMode = parseBooleanEnv(
    "TRUST_MODE",
    CONFIG_DEFAULTS.trustMode,
  );

  // --- PERMISSION_TIMEOUT_MS (optional number, default 60000) ---
  const permissionTimeoutMs = parseNumberEnv(
    "PERMISSION_TIMEOUT_MS",
    CONFIG_DEFAULTS.permissionTimeoutMs,
  );

  // --- POLL_TIMEOUT_S (optional number, default 30) ---
  const pollTimeoutS = parseNumberEnv(
    "POLL_TIMEOUT_S",
    CONFIG_DEFAULTS.pollTimeoutS,
  );

  // --- KIRO_TRANSPORT (optional, default "tmux") ---
  const rawTransport = (process.env["KIRO_TRANSPORT"] || CONFIG_DEFAULTS.kiroTransport).toLowerCase();
  if (rawTransport !== "tmux" && rawTransport !== "acp") {
    throw new Error(`KIRO_TRANSPORT must be "tmux" or "acp", got "${rawTransport}"`);
  }
  const kiroTransport = rawTransport as KiroTransport;

  // --- TMUX_SESSION (optional, default "kiro-bridge") ---
  const tmuxSession = process.env["TMUX_SESSION"] || CONFIG_DEFAULTS.tmuxSession;

  // --- TMUX_CAPTURE_DELAY_SEC (optional, default 3) ---
  const tmuxCaptureDelaySec = parseNumberEnv(
    "TMUX_CAPTURE_DELAY_SEC",
    CONFIG_DEFAULTS.tmuxCaptureDelaySec,
  );

  // --- TMUX_MAX_WAIT_SEC (optional, default 300) ---
  const tmuxMaxWaitSec = parseNumberEnv(
    "TMUX_MAX_WAIT_SEC",
    CONFIG_DEFAULTS.tmuxMaxWaitSec,
  );

  // --- LOG_LEVEL (optional, default "low") ---
  const rawLogLevel = (process.env["LOG_LEVEL"] || CONFIG_DEFAULTS.logLevel).toLowerCase();
  if (rawLogLevel !== "off" && rawLogLevel !== "low" && rawLogLevel !== "debug") {
    throw new Error(`LOG_LEVEL must be "off", "low", or "debug", got "${rawLogLevel}"`);
  }
  const logLevel = rawLogLevel as LogLevel;

  // --- GROQ_API_KEY (optional, enables STT) ---
  const groqApiKey = process.env["GROQ_API_KEY"] ?? "";
  const sttEnabled = parseBooleanEnv("STT_ENABLED", groqApiKey.length > 0);
  const sttModel = process.env["STT_MODEL"] || CONFIG_DEFAULTS.sttModel;

  // --- TTS (optional, default enabled) ---
  const ttsEnabled = parseBooleanEnv("TTS_ENABLED", CONFIG_DEFAULTS.ttsEnabled);
  const ttsVoice = process.env["TTS_VOICE"] || CONFIG_DEFAULTS.ttsVoice;

  return {
    telegramBotToken: token,
    allowedUserIds,
    kiroCLIPath,
    workingDir,
    trustMode,
    permissionTimeoutMs,
    pollTimeoutS,
    kiroTransport,
    tmuxSession,
    tmuxCaptureDelaySec,
    tmuxMaxWaitSec,
    logLevel,
    sttEnabled,
    groqApiKey,
    sttModel,
    ttsEnabled,
    ttsVoice,
  };
}

/** Parse an env var as a boolean ("true"/"1" → true, anything else → false). */
function parseBooleanEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

/** Parse an env var as a finite number. Throws if present but not numeric. */
function parseNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${key} must be a valid number, got "${raw}"`);
  }
  return n;
}
