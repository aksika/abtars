/**
 * transport-config/loader.ts — config directory, models/catalog reads,
 * transport read/recovery chain, and the sole in-memory cache.
 * Read-only: never writes, never mutates input, never repairs.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { getEnv } from "../env-schema.js";
import { logDebug, logInfo, logWarn } from "../logger.js";
import type {
  ModelCatalog,
  ModelCost,
  TransportConfig,
  TransportConfigIssue,
  TransportConfigSource,
  TransportLoadResult,
} from "./types.js";
import { validateTransportConfig } from "./validator.js";

const TAG = "transport-config";

let cachedTransport: TransportConfig | null = null;
let cachedSource: TransportConfigSource | null = null;

export function configDir(): string {
  return join(abtarsHome(), "config");
}

export function loadModels(): ModelCatalog {
  const p = join(configDir(), getEnv().modelsConfig);
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as ModelCatalog;
    for (const entry of Object.values(raw)) {
      if (entry.cost && (entry.cost.input != null || entry.cost.output != null)) {
        entry.cost.display = computeCostDisplay(entry.cost);
      }
    }
    return raw;
  } catch (err) {
    logWarn(TAG, `Failed to load models.json: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

export function computeCostDisplay(cost: ModelCost): { inputPer1M: string; outputPer1M: string } {
  const fmt = (perToken: number): string => {
    if (!perToken) return "0.00";
    return (perToken * 1_000_000).toFixed(2);
  };
  return { inputPer1M: fmt(cost.input), outputPer1M: fmt(cost.output) };
}

/**
 * Load transport config with structured result.
 * Never writes to disk, never mutates input, never auto-repairs.
 */
export function loadTransportStructured(): TransportLoadResult {
  if (cachedTransport && cachedSource) {
    const vr = validateTransportConfig(cachedTransport);
    if (!vr.ok) {
      cachedTransport = null;
      cachedSource = null;
      return { ok: false, issues: vr.issues, state: "invalid" };
    }
    return { ok: true, config: vr.config, source: cachedSource };
  }

  const dir = configDir();
  const p = join(dir, getEnv().transportConfig);

  // Try primary — distinguish file-not-found from corrupt content
  const primaryExists = existsSync(p);
  if (primaryExists) {
    const primaryData = tryParseJson(p);
    if (primaryData) {
      const vr = validateTransportConfig(primaryData);
      if (vr.ok) {
        cachedTransport = vr.config;
        cachedSource = "primary";
        return { ok: true, config: vr.config, source: "primary" };
      }
      // Primary exists but is invalid — don't fall through to backup/emergency
      cachedTransport = null;
      cachedSource = null;
      return { ok: false, issues: vr.issues, state: "invalid", source: "primary" };
    }
    // File exists but could not be parsed — treat as invalid, not missing
    cachedTransport = null;
    cachedSource = null;
    const parseIssue: TransportConfigIssue = {
      code: "unsupported_schema",
      path: "transport.json",
      message: `Failed to parse ${p}`,
    };
    return { ok: false, issues: [parseIssue], state: "invalid", source: "primary" };
  }

  // Try backup
  const oldPath = p.replace(".json", ".old.json");
  const backupData = tryParseJson(oldPath);
  if (backupData) {
    const vr = validateTransportConfig(backupData);
    if (vr.ok) {
      cachedTransport = vr.config;
      cachedSource = "backup";
      logWarn(TAG, `transport.json missing — using transport.old.json as in-memory source`);
      return { ok: true, config: vr.config, source: "backup" };
    }
  }

  // Try default template
  const defaultPath = join(dir, "transport.default.json");
  const defaultData = tryParseJson(defaultPath);
  if (defaultData) {
    const vr = validateTransportConfig(defaultData);
    if (vr.ok) {
      cachedTransport = vr.config;
      cachedSource = "default";
      logWarn(TAG, `transport.json missing — using transport.default.json as in-memory source`);
      return { ok: true, config: vr.config, source: "default" };
    }
  }

  return { ok: false, issues: [], state: "missing" };
}

/** Try to parse a JSON file. Returns null if file doesn't exist or is unreadable. Never writes, never migrates. */
function tryParseJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    logDebug(TAG, `Failed to load ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Backward-compatible loadTransport for existing callers.
 * Returns null when no valid config is available.
 * Never writes, never mutates, never auto-repairs.
 */
export function loadTransport(): TransportConfig | null {
  const result = loadTransportStructured();
  if (result.ok) {
    logInfo(TAG, `Loaded transport config v${result.config.schemaVersion} (activeRoute: ${result.config.activeRoute}, source: ${result.source})`);
    return result.config;
  }
  return null;
}

/** Clear in-memory cache only (no disk writes). */
export function clearTransportCache(): void {
  cachedTransport = null;
  cachedSource = null;
}

/** Internal writer hook; intentionally omitted from the public barrel. */
export function cacheTransportAfterWrite(config: TransportConfig): void {
  cachedTransport = config;
  cachedSource = "primary";
}
