/**
 * env-schema.ts — Central env var schema. Single source of truth.
 * All env access goes through getEnv(). No process.env reads elsewhere.
 *
 * Usage:
 *   import { getEnv } from "./env-schema.js";
 *   const env = getEnv();
 *   env.bedTime // "0:30"
 *
 * Boot:
 *   import { initEnv } from "./env-schema.js";
 *   initEnv(); // call once at boot, before anything reads config
 */

import { logInfo, logWarn } from "./logger.js";

// ── Schema definition ───────────────────────────────────────────────────────

type EnvType = "string" | "int" | "bool" | "time";

interface EnvVarDef {
  env: string;
  type: EnvType;
  default?: string;
  required?: boolean;
  description: string;
}

// All env vars in one place. Add new vars here, nowhere else.
const SCHEMA: readonly EnvVarDef[] = [
  // ── Core ──
  { env: "ABTARS_HOME", type: "string", description: "Base directory for runtime data" },
  { env: "WORKING_DIR", type: "string", default: "~/.abtars/workspace", description: "Agent working directory (sandbox)" },
  { env: "MAIN_CHAT_ID", type: "string", description: "Primary chat ID for operator notifications" },
  { env: "MAIN_CHAT_PROVIDER", type: "string", default: "telegram", description: "Platform for MAIN_CHAT_ID: telegram | discord" },
  { env: "LOG_LEVEL", type: "string", default: "low", description: "Log level: off, low, debug" },
  { env: "LOG_FORMAT", type: "string", default: "text", description: "Log format: text or json" },

  // ── Transport ──
  { env: "AGENT_CLI_PATH", type: "string", description: "Override path to agent CLI binary" },
  { env: "API_KEY", type: "string", description: "Default API key fallback (prefer per-provider keys)" },
  { env: "TMUX_SESSION", type: "string", default: "kiro", description: "Tmux session name" },
  { env: "DEFAULT_TRANSPORT", type: "string", default: "api", description: "Default transport type" },
  { env: "TRANSPORT_CONFIG", type: "string", default: "transport.json", description: "Transport config filename" },
  { env: "MODELS_CONFIG", type: "string", default: "models.json", description: "Models config filename" },

  // ── Transport timeouts ──
  { env: "PROMPT_TIMEOUT_SEC", type: "int", default: "180", description: "ACP prompt timeout (seconds)" },
  { env: "MODEL_API_TIMEOUT_SEC", type: "int", default: "30", description: "Direct API model timeout (seconds)" },
  { env: "WATCHDOG_TOOL_TIMEOUT_SEC", type: "int", default: "180", description: "Watchdog tool call timeout (seconds)" },
  { env: "WATCHDOG_SILENT_SEC", type: "int", default: "300", description: "Watchdog silent timeout (seconds)" },
  { env: "WATCHDOG_ENDLESS_SEC", type: "int", default: "600", description: "Watchdog endless loop timeout (seconds)" },

  // ── Telegram ──
  { env: "TELEGRAM_BOT_TOKEN", type: "string", description: "Telegram bot token" },
  { env: "TELEGRAM_TIMEOUT_SEC", type: "int", default: "10", description: "Telegram API timeout (seconds)" },
  { env: "TELEGRAM_FILE_TIMEOUT_SEC", type: "int", default: "60", description: "Telegram file up/download timeout (seconds)" },
  { env: "POLL_TIMEOUT_S", type: "int", default: "30", description: "Telegram long-poll timeout (seconds)" },

  // ── Discord ──
  { env: "DISCORD_BOT_TOKEN", type: "string", description: "Discord bot token" },
  { env: "DISCORD_APP_ID", type: "string", description: "Discord application ID" },
  { env: "DISCORD_GROUP_MENTIONS", type: "string", default: "required", description: "Group mention mode: required (need @mention) | optional (bot listens to all, decides itself)" },
  { env: "DISCORD_ALLOW_BOTS", type: "string", default: "none", description: "Bot message policy: none | mentions | all" },
  { env: "DISCORD_FREE_CHANNELS", type: "string", default: "", description: "Comma-separated channel IDs where bot responds without @mention" },

  // ── Context window ──
  { env: "CTX_WARN_PCT", type: "int", default: "70", description: "Context % to warn user" },
  { env: "CTX_COMPACT_PCT", type: "int", default: "80", description: "Context % to auto-compact" },
  { env: "CTX_AGGRESSIVE_PCT", type: "int", default: "90", description: "Context % for aggressive compaction" },
  { env: "CTX_IDLE_COMPACT_PCT", type: "int", default: "65", description: "Context % for idle compaction" },
  { env: "CTX_IDLE_COMPACT_MIN", type: "int", default: "10", description: "Minutes idle before floating compaction" },

  // ── Typing / streaming ──
  { env: "TYPING_TTL_SEC", type: "int", default: "300", description: "Typing indicator TTL (seconds)" },
  { env: "TYPING_SILENT_THRESHOLD_SEC", type: "int", default: "90", description: "Silent threshold before still-working msg (seconds)" },
  { env: "STREAM_FLUSH_SEC", type: "int", default: "3", description: "Stream edit flush interval (seconds, 0=disabled)" },

  // ── Memory ──
  { env: "MEMORY", type: "string", default: "abmind", description: "Memory provider: 'abmind' (default) or 'none'" },
  { env: "ACTIVE_MEMORY", type: "bool", default: "true", description: "Enable ambient recall on every turn" },
  { env: "PRIMING_MODEL_TOPICS", type: "bool", default: "true", description: "Use model-generated topics for priming" },

  // ── ABM-L rendering (abmind, read by abmind directly) ──
  { env: "ABML_VERSION", type: "string", default: "plain", description: "ABM-L codec: plain | v0 | v1" },
  { env: "ABML_MIN_CHARS", type: "int", default: "100", description: "Min chars before ABM-L compression kicks in (v0)" },

  // ── Three-tier context assembly (#348, abmind) ──
  { env: "CONTEXT_TIER_ENABLED", type: "bool", default: "true", description: "Enable three-tier context assembly (#348)" },
  { env: "CONTEXT_TIER_TAIL", type: "int", default: "20", description: "Last N turns kept verbatim (#348 tail)" },
  { env: "CONTEXT_TIER_MIDDLE", type: "int", default: "50", description: "Next M turns rendered as ABM-L (#348 middle)" },
  { env: "COMPACTION_LLM_ENABLED", type: "bool", default: "false", description: "LLM refinement for middle-tier rendering (#348 Phase 2)" },

  // ── Sleep ──
  { env: "BED_TIME", type: "time", default: "0:30", description: "Daily sleep trigger time (H:MM or HH:MM)" },
  { env: "WAKE_TIME", type: "time", default: "7:00", description: "Wake time for platform detection" },
  { env: "BED_QUIET_MIN", type: "int", default: "7", description: "Quiet minutes before sleep (rounds up to nearest heartbeat cycle)" },
  { env: "HARDWARE_SLEEP_AFTER_DREAMY", type: "bool", default: "false", description: "Enable hardware sleep after Dreamy completes" },
  { env: "SLEEP_MODEL", type: "string", description: "Model override for Dreamy sleep agent" },
  { env: "SLEEP_QUALITY", type: "string", description: "Sleep quality override" },

  // ── Voice ──
  { env: "STT_ENABLED", type: "bool", default: "false", description: "Enable speech-to-text" },
  { env: "STT_MODEL", type: "string", default: "whisper-large-v3-turbo", description: "STT model name" },
  { env: "TTS_ENABLED", type: "bool", default: "true", description: "Enable text-to-speech voice replies" },
  { env: "TTS_VOICE", type: "string", default: "alloy", description: "TTS voice name" },

  // ── Self-healer ──
  { env: "SELFHEAL_ENABLED", type: "bool", default: "false", description: "Enable self-healer task" },

  // ── Browser ──
  { env: "BROWSER_ENGINE", type: "string", default: "cloakbrowser", description: "Browser engine: cloakbrowser" },
  { env: "BROWSER_HEADED", type: "bool", default: "false", description: "Run browser in headed mode" },
  { env: "BROWSER_NO_SANDBOX", type: "bool", default: "false", description: "Disable browser sandbox" },
  { env: "BROWSER_CHANNEL", type: "string", description: "Browser channel (e.g. chrome)" },
  { env: "BROWSER_DOCKER", type: "bool", default: "false", description: "Use Docker for browser" },
  { env: "BROWSER_IDLE_STOP_MIN", type: "int", default: "10", description: "Minutes idle before stopping browser container" },
  { env: "BROWSER_ALLOWED_DOMAINS", type: "string", default: "", description: "Comma-separated allowed domains" },
  { env: "BROWSER_SOCKET_PATH", type: "string", default: "/run/browser/browser.sock", description: "Browser IPC socket path" },
  { env: "BROWSER_MAX_SESSIONS", type: "int", default: "3", description: "Max concurrent browser sessions" },
  { env: "BROWSER_SESSION_TIMEOUT_SEC", type: "int", default: "300", description: "Browser session timeout (seconds)" },
  { env: "WEB_SCRAPE_USER_AGENT", type: "string", description: "User agent for web scraping" },
  { env: "WEB_SCRAPE_PLAYWRIGHT_TIMEOUT_SEC", type: "int", default: "30", description: "Playwright page timeout (seconds)" },
  { env: "SSRF_CHECK", type: "bool", default: "true", description: "Enable SSRF protection for browser" },
  { env: "BROWSING_AGENT", type: "string", description: "Model override for browsing agent" },

  // ── Misc ──
  { env: "DISABLED_CAPABILITIES", type: "string", default: "", description: "Comma-separated capabilities to disable" },
  { env: "CODING_MODEL", type: "string", description: "Model override for coding mode" },
  { env: "DASHBOARD_MODULE", type: "string", description: "Custom dashboard module path" },
  { env: "NOTEBOOKLM_ENABLED", type: "bool", default: "false", description: "Enable NotebookLM integration" },
  { env: "NOTEBOOKLM_DEFAULT_NOTEBOOK", type: "string", default: "", description: "Default NotebookLM notebook" },
  { env: "PERMISSION_TIMEOUT_SEC", type: "int", default: "60", description: "Permission prompt timeout (seconds)" },
  { env: "TRUST_MODE", type: "bool", default: "false", description: "Skip permission prompts" },
  { env: "SECURITY_MODE", type: "string", default: "off", description: "Security mode: off | guardrails | seatbelt | docker" },
  { env: "MAX_AGENT_CALL_PER_HOUR", type: "int", required: true, description: "Agent API rate limit: max requests per caller per hour" },
  { env: "MAX_AGENT_CALL_PER_DAY", type: "int", required: true, description: "Agent API rate limit: max requests per caller per day" },
  { env: "TELEGRAM_ENABLED", type: "bool", default: "", description: "Enable Telegram platform (fallback: token presence)" },
  { env: "DISCORD_ENABLED", type: "bool", default: "", description: "Enable Discord platform (fallback: token presence)" },
  { env: "IRC_ENABLED", type: "bool", default: "", description: "Enable IRC platform (fallback: irc.json presence)" },
  { env: "TUI_ENABLED", type: "bool", default: "false", description: "Enable TUI socket server at ~/.abtars/tui.sock (#1315)" },
  { env: "ENABLE_DASHBOARD", type: "bool", default: "false", description: "Enable web dashboard (exposes port)" },
  { env: "ENABLE_AGENT_API", type: "bool", default: "false", description: "Enable A2A agent API (exposes port)" },
  { env: "ENABLE_ASYNC_DELEGATION", type: "bool", default: "false", description: "Enable async session delegation tools (spawn/check/terminate)" },
  { env: "MAX_SESSIONS", type: "int", default: "10", description: "Max concurrent managed sessions per user" },

  // ── Artifact Store (S3) ──
  { env: "ARTIFACT_S3_ENDPOINT", type: "string", description: "S3-compatible endpoint for artifact store" },
  { env: "ARTIFACT_S3_KEY", type: "string", description: "S3 access key ID" },
  { env: "ARTIFACT_S3_SECRET", type: "string", description: "S3 secret access key" },
  { env: "ARTIFACT_S3_BUCKET", type: "string", default: "abtars-artifacts", description: "S3 bucket name" },
  { env: "ARTIFACT_S3_REGION", type: "string", default: "auto", description: "S3 region (default auto for R2)" },
] as const;

// ── Parsed config type ──────────────────────────────────────────────────────

/** Parsed time value from "H:MM" or "HH:MM" format. */
export interface TimeValue { hour: number; minute: number; raw: string; }

export interface EnvConfig {
  // Core
  abtarsHome: string;
  workingDir: string;
  mainChatId: string | undefined;
  mainChatProvider: "telegram" | "discord";
  logLevel: string;
  logFormat: "text" | "json";

  // Transport
  agentCliPath: string | undefined;
  apiKey: string | undefined;
  tmuxSession: string;
  defaultTransport: string;
  transportConfig: string;
  modelsConfig: string;

  // Transport timeouts
  promptTimeoutSec: number;
  modelApiTimeoutMs: number;
  watchdogToolTimeoutSec: number;
  watchdogSilentSec: number;
  watchdogEndlessSec: number;

  // Telegram
  telegramBotToken: string | undefined;
  telegramTimeoutMs: number;
  telegramFileTimeoutMs: number;
  pollTimeoutS: number;

  // Discord
  discordBotToken: string | undefined;
  discordAppId: string | undefined;
  discordGroupMentions: string;
  discordAllowBots: string;
  discordFreeChannels: Set<string>;

  // Context window
  ctxWarnPct: number;
  ctxCompactPct: number;
  ctxAggressivePct: number;
  ctxIdleCompactPct: number;
  ctxIdleCompactMin: number;

  // Typing / streaming
  typingTtlMs: number;
  typingSilentThresholdMs: number;
  streamFlushSec: number;

  // Memory
  memory: string;
  activeMemory: boolean;
  primingModelTopics: boolean;

  // Sleep
  bedTime: TimeValue;
  wakeTime: TimeValue;
  bedQuietMin: number;
  hardwareSleepAfterDreamy: boolean;
  sleepModel: string | undefined;
  sleepQuality: string | undefined;

  // Voice
  sttEnabled: boolean;
  sttModel: string;
  ttsEnabled: boolean;
  ttsVoice: string;

  // Self-healer
  selfhealEnabled: boolean;

  // Browser
  browserEngine: string;
  browserHeaded: boolean;
  browserNoSandbox: boolean;
  browserChannel: string | undefined;
  browserDocker: boolean;
  browserIdleStopMin: number;
  browserAllowedDomains: string;
  browserSocketPath: string;
  browserMaxSessions: number;
  browserSessionTimeoutMs: number;
  webScrapeUserAgent: string | undefined;
  webScrapePlaywrightTimeoutMs: number;
  ssrfCheck: boolean;
  browsingAgent: string | undefined;

  // Misc
  disabledCapabilities: string;
  codingModel: string | undefined;
  dashboardModule: string | undefined;
  notebooklmEnabled: boolean;
  notebooklmDefaultNotebook: string;
  permissionTimeoutMs: number;
  trustMode: boolean;
  securityMode: string;
  enableDashboard: boolean;
  enableAgentApi: boolean;
  enableAsyncDelegation: boolean;
  maxSessions: number;
  maxAgentCallPerHour: number;
  maxAgentCallPerDay: number;

  /** Dynamic API key lookup — for provider.apiKeyEnv pattern. */
  getApiKey(envName: string): string | undefined;
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

function parseTime(raw: string, varName: string): TimeValue {
  const parts = raw.split(":");
  const hour = parseInt(parts[0] ?? "", 10);
  const minute = parseInt(parts[1] ?? "0", 10);
  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid ${varName}: "${raw}" — expected H:MM or HH:MM (e.g. "0:30", "14:00")`);
  }
  return { hour, minute, raw };
}

function parseIntSafe(raw: string, varName: string): number {
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`Invalid ${varName}: "${raw}" — expected integer`);
  return n;
}

function parseBool(raw: string): boolean {
  return raw.toLowerCase() === "true" || raw === "1";
}

// ── Singleton (globalThis to survive esbuild chunk duplication #1171) ────────

const _G = globalThis as unknown as { __abtarsEnv: Readonly<EnvConfig> | null };

/** Get the parsed env config. Auto-initializes on first call if needed. */
export function getEnv(): Readonly<EnvConfig> {
  if (!_G.__abtarsEnv) initEnv();
  return _G.__abtarsEnv!;
}

/** Sanitized config dump — masks API keys/tokens, shows everything else. For /status. */
export function envDump(): Record<string, string> {
  const env = getEnv();
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "function") continue;
    const strVal = value == null ? "(not set)" : String(value);
    // Mask anything that looks like a secret
    if (/token|key|secret|password/i.test(key) && strVal.length > 4) {
      result[key] = strVal.slice(0, 4) + "…" + strVal.slice(-2);
    } else {
      result[key] = strVal;
    }
  }
  return result;
}

/** Initialize env config from process.env. Call once at boot. */
export function initEnv(): Readonly<EnvConfig> {
  const knownVars = new Set(SCHEMA.map(s => s.env));
  const warnings: string[] = [];

  // Detect typos: only warn if an unknown var is close (Levenshtein ≤ 3) to a known abtars var.
  // System vars (QT_*, POWERSHELL_*, etc.) are far from any known var → silently ignored.
  const envKeys = Object.keys(process.env).filter(k => /^[A-Z_]+$/.test(k));
  for (const k of envKeys) {
    if (knownVars.has(k)) continue;
    // Allow *_API_KEY pattern (provider keys referenced dynamically by transport.json)
    if (k.endsWith("_API_KEY") || k.endsWith("_API_ID")) continue;
    // Allow HA_* (Home Assistant, loaded from .env.skills)
    if (k.startsWith("HA_")) continue;
    const suggestion = findClosest(k, knownVars);
    if (suggestion) {
      warnings.push(`Unknown env var ${k} — did you mean ${suggestion}?`);
    }
  }

  function read(envName: string): string | undefined {
    return process.env[envName]?.trim() || undefined;
  }

  function readOr(envName: string, fallback: string): string {
    return read(envName) ?? fallback;
  }

  const env: EnvConfig = {
    abtarsHome: readOr("ABTARS_HOME", ""),
    workingDir: readOr("WORKING_DIR", "."),
    mainChatId: read("MAIN_CHAT_ID"),
    mainChatProvider: (read("MAIN_CHAT_PROVIDER") ?? "telegram") === "discord" ? "discord" : "telegram",
    logLevel: readOr("LOG_LEVEL", "low").toLowerCase(),
    logFormat: readOr("LOG_FORMAT", "text") === "json" ? "json" : "text",

    agentCliPath: read("AGENT_CLI_PATH"),
    apiKey: read("API_KEY"),
    tmuxSession: readOr("TMUX_SESSION", "kiro"),
    defaultTransport: readOr("DEFAULT_TRANSPORT", "api"),
    transportConfig: readOr("TRANSPORT_CONFIG", "transport.json").replace("config/", ""),
    modelsConfig: readOr("MODELS_CONFIG", "models.json").replace("config/", ""),

    promptTimeoutSec: parseIntSafe(readOr("PROMPT_TIMEOUT_SEC", "180"), "PROMPT_TIMEOUT_SEC"),
    modelApiTimeoutMs: parseIntSafe(readOr("MODEL_API_TIMEOUT_SEC", "120"), "MODEL_API_TIMEOUT_SEC") * 1000,
    watchdogToolTimeoutSec: parseIntSafe(readOr("WATCHDOG_TOOL_TIMEOUT_SEC", "180"), "WATCHDOG_TOOL_TIMEOUT_SEC"),
    watchdogSilentSec: parseIntSafe(readOr("WATCHDOG_SILENT_SEC", "300"), "WATCHDOG_SILENT_SEC"),
    watchdogEndlessSec: parseIntSafe(readOr("WATCHDOG_ENDLESS_SEC", "600"), "WATCHDOG_ENDLESS_SEC"),

    telegramBotToken: read("TELEGRAM_BOT_TOKEN"),
    telegramTimeoutMs: parseIntSafe(readOr("TELEGRAM_TIMEOUT_SEC", "10"), "TELEGRAM_TIMEOUT_SEC") * 1000,
    telegramFileTimeoutMs: parseIntSafe(readOr("TELEGRAM_FILE_TIMEOUT_SEC", "60"), "TELEGRAM_FILE_TIMEOUT_SEC") * 1000,
    pollTimeoutS: parseIntSafe(readOr("POLL_TIMEOUT_S", "30"), "POLL_TIMEOUT_S"),

    discordBotToken: read("DISCORD_BOT_TOKEN"),
    discordAppId: read("DISCORD_APP_ID"),
    discordGroupMentions: readOr("DISCORD_GROUP_MENTIONS", "required"),
    discordAllowBots: readOr("DISCORD_ALLOW_BOTS", "none"),
    discordFreeChannels: new Set(readOr("DISCORD_FREE_CHANNELS", "").split(",").map(s => s.trim()).filter(Boolean)),

    ctxWarnPct: parseIntSafe(readOr("CTX_WARN_PCT", "70"), "CTX_WARN_PCT"),
    ctxCompactPct: parseIntSafe(readOr("CTX_COMPACT_PCT", "80"), "CTX_COMPACT_PCT"),
    ctxAggressivePct: parseIntSafe(readOr("CTX_AGGRESSIVE_PCT", "90"), "CTX_AGGRESSIVE_PCT"),
    ctxIdleCompactPct: parseIntSafe(readOr("CTX_IDLE_COMPACT_PCT", "65"), "CTX_IDLE_COMPACT_PCT"),
    ctxIdleCompactMin: parseIntSafe(readOr("CTX_IDLE_COMPACT_MIN", "10"), "CTX_IDLE_COMPACT_MIN"),

    typingTtlMs: parseIntSafe(readOr("TYPING_TTL_SEC", "300"), "TYPING_TTL_SEC") * 1000,
    typingSilentThresholdMs: parseIntSafe(readOr("TYPING_SILENT_THRESHOLD_SEC", "90"), "TYPING_SILENT_THRESHOLD_SEC") * 1000,
    streamFlushSec: parseIntSafe(readOr("STREAM_FLUSH_SEC", "3"), "STREAM_FLUSH_SEC"),

    activeMemory: parseBool(readOr("ACTIVE_MEMORY", "true")),
    memory: readOr("MEMORY", "auto"),
    primingModelTopics: read("PRIMING_MODEL_TOPICS") !== "false",

    bedTime: parseTime(readOr("BED_TIME", "0:30"), "BED_TIME"),
    wakeTime: parseTime(readOr("WAKE_TIME", "7:00"), "WAKE_TIME"),
    bedQuietMin: parseIntSafe(readOr("BED_QUIET_MIN", "7"), "BED_QUIET_MIN"),
    hardwareSleepAfterDreamy: parseBool(readOr("HARDWARE_SLEEP_AFTER_DREAMY", "false")),
    sleepModel: read("SLEEP_MODEL"),
    sleepQuality: read("SLEEP_QUALITY"),

    sttEnabled: parseBool(readOr("STT_ENABLED", "false")),
    sttModel: readOr("STT_MODEL", "whisper-large-v3-turbo"),
    ttsEnabled: parseBool(readOr("TTS_ENABLED", "false")),
    ttsVoice: readOr("TTS_VOICE", "alloy"),

    selfhealEnabled: parseBool(readOr("SELFHEAL_ENABLED", "false")),

    browserEngine: readOr("BROWSER_ENGINE", "cloakbrowser"),
    browserHeaded: parseBool(readOr("BROWSER_HEADED", "false")),
    browserNoSandbox: parseBool(readOr("BROWSER_NO_SANDBOX", "false")),
    browserChannel: read("BROWSER_CHANNEL"),
    browserDocker: parseBool(readOr("BROWSER_DOCKER", "false")),
    browserIdleStopMin: parseIntSafe(readOr("BROWSER_IDLE_STOP_MIN", "10"), "BROWSER_IDLE_STOP_MIN"),
    browserAllowedDomains: readOr("BROWSER_ALLOWED_DOMAINS", ""),
    browserSocketPath: readOr("BROWSER_SOCKET_PATH", "/run/browser/browser.sock"),
    browserMaxSessions: parseIntSafe(readOr("BROWSER_MAX_SESSIONS", "3"), "BROWSER_MAX_SESSIONS"),
    browserSessionTimeoutMs: parseIntSafe(readOr("BROWSER_SESSION_TIMEOUT_SEC", "300"), "BROWSER_SESSION_TIMEOUT_SEC") * 1000,
    webScrapeUserAgent: read("WEB_SCRAPE_USER_AGENT"),
    webScrapePlaywrightTimeoutMs: parseIntSafe(readOr("WEB_SCRAPE_PLAYWRIGHT_TIMEOUT_SEC", "30"), "WEB_SCRAPE_PLAYWRIGHT_TIMEOUT_SEC") * 1000,
    ssrfCheck: read("SSRF_CHECK") !== "0",
    browsingAgent: read("BROWSING_AGENT"),

    disabledCapabilities: readOr("DISABLED_CAPABILITIES", ""),
    codingModel: read("CODING_MODEL"),
    dashboardModule: read("DASHBOARD_MODULE"),
    notebooklmEnabled: parseBool(readOr("NOTEBOOKLM_ENABLED", "false")),
    notebooklmDefaultNotebook: readOr("NOTEBOOKLM_DEFAULT_NOTEBOOK", ""),
    permissionTimeoutMs: parseIntSafe(readOr("PERMISSION_TIMEOUT_SEC", "60"), "PERMISSION_TIMEOUT_SEC") * 1000,
    trustMode: parseBool(readOr("TRUST_MODE", "false")),
    securityMode: readOr("SECURITY_MODE", "off"),
    enableDashboard: parseBool(readOr("ENABLE_DASHBOARD", "false")),
    enableAgentApi: parseBool(readOr("ENABLE_AGENT_API", "false")),
    enableAsyncDelegation: parseBool(readOr("ENABLE_ASYNC_DELEGATION", "false")),
    maxSessions: parseIntSafe(readOr("MAX_SESSIONS", "10"), "MAX_SESSIONS"),
    maxAgentCallPerHour: parseIntSafe(readOr("MAX_AGENT_CALL_PER_HOUR", "30"), "MAX_AGENT_CALL_PER_HOUR"),
    maxAgentCallPerDay: parseIntSafe(readOr("MAX_AGENT_CALL_PER_DAY", "100"), "MAX_AGENT_CALL_PER_DAY"),

    getApiKey(envName: string): string | undefined {
      return process.env[envName]?.trim() || undefined;
    },
  };

  // Count overrides
  let overrideCount = 0;
  for (const def of SCHEMA) {
    if (def.default !== undefined && read(def.env) !== undefined) overrideCount++;
  }

  for (const w of warnings) logWarn("env", w);
  logInfo("env", `${SCHEMA.length} vars loaded, ${overrideCount} overridden, ${warnings.length} warnings`);

  _G.__abtarsEnv = Object.freeze(env);
  return _G.__abtarsEnv;
}

/** Reset singleton (for tests only). */
export function _resetEnv(): void { _G.__abtarsEnv = null; }

// ── Typo detection helpers ──────────────────────────────────────────────────

/** Find closest known var name (Levenshtein distance ≤ 3). */
function findClosest(input: string, known: Set<string>): string | undefined {
  let best: string | undefined;
  let bestDist = 4; // threshold
  for (const k of known) {
    const d = levenshtein(input, k);
    if (d < bestDist) { bestDist = d; best = k; }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0]![j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(matrix[i - 1]![j]! + 1, matrix[i]![j - 1]! + 1, matrix[i - 1]![j - 1]! + cost);
    }
  }
  return matrix[b.length]![a.length]!;
}
