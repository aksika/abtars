import type { NotebookLMConfig } from "../types/index.js";

const DEFAULTS = {
  enabled: false,
  cliPath: "/mnt/c/Users/qakosal/workspace/openclaw/notebooklm-mcp-cli",
  timeoutMs: 30_000,
  defaultNotebook: "",
  queryCacheTtlMs: 300_000,
} as const satisfies NotebookLMConfig;

/**
 * Load NotebookLM Layer 6 configuration from environment variables.
 * Returns a fully-populated config with defaults applied.
 */
export function loadNotebookLMConfig(): NotebookLMConfig {
  const rawEnabled = process.env["NOTEBOOKLM_ENABLED"];
  const enabled = rawEnabled === "true" || rawEnabled === "1";

  const cliPath = process.env["NOTEBOOKLM_CLI_PATH"] || DEFAULTS.cliPath;

  const rawTimeout = process.env["NOTEBOOKLM_TIMEOUT_MS"];
  const timeoutMs = rawTimeout ? parseFiniteNumber(rawTimeout, DEFAULTS.timeoutMs) : DEFAULTS.timeoutMs;

  const defaultNotebook = process.env["NOTEBOOKLM_DEFAULT_NOTEBOOK"] || DEFAULTS.defaultNotebook;

  const rawCacheTtl = process.env["NOTEBOOKLM_QUERY_CACHE_TTL_MS"];
  const queryCacheTtlMs = rawCacheTtl ? parseFiniteNumber(rawCacheTtl, DEFAULTS.queryCacheTtlMs) : DEFAULTS.queryCacheTtlMs;

  return { enabled, cliPath, timeoutMs, defaultNotebook, queryCacheTtlMs };
}

function parseFiniteNumber(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
