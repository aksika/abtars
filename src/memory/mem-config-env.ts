/**
 * mem-config.ts — Standalone memory.env config loader.
 * Separate from bridge config. Reads from ~/.agentbridge/memory.env.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "./mem-paths.js";

export type SearchMode = "hybrid" | "embedding" | "signature";

export interface MemoryEnvConfig {
  searchMode: SearchMode;
  maxDbSizeMb: number;
  originalTtlDays: number;
  englishTtlDays: number;
  agingEnabled: boolean;
  signatureBits: number;
}

const DEFAULTS: MemoryEnvConfig = {
  searchMode: "hybrid",
  maxDbSizeMb: 4096,
  originalTtlDays: 90,
  englishTtlDays: 14,
  agingEnabled: true,
  signatureBits: 256,
};

/** Load memory.env from ~/.agentbridge/memory.env. Falls back to defaults. */
export function loadMemoryEnv(): MemoryEnvConfig {
  const envPath = join(agentBridgeHome(), "memory.env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && val) process.env[key] = process.env[key] ?? val;
    }
  }

  const mode = process.env["MEMORY_SEARCH_MODE"];
  return {
    searchMode: (mode === "hybrid" || mode === "embedding" || mode === "signature") ? mode : DEFAULTS.searchMode,
    maxDbSizeMb: parseInt(process.env["MEMORY_MAX_DB_SIZE_MB"] ?? "", 10) || DEFAULTS.maxDbSizeMb,
    originalTtlDays: parseInt(process.env["MEMORY_ORIGINAL_TTL_DAYS"] ?? "", 10) || DEFAULTS.originalTtlDays,
    englishTtlDays: parseInt(process.env["MEMORY_ENGLISH_TTL_DAYS"] ?? "", 10) || DEFAULTS.englishTtlDays,
    agingEnabled: (process.env["MEMORY_AGING_ENABLED"] ?? "true") !== "false",
    signatureBits: parseInt(process.env["SIGNATURE_BITS"] ?? "", 10) || DEFAULTS.signatureBits,
  };
}
