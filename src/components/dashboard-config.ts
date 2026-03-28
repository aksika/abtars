/**
 * Dashboard configuration, data models, and utility functions for the
 * Kiro Professor Web UI.
 */

// ── Dashboard Config ────────────────────────────────────────────────────────

export type DashboardConfig = {
  webPort: number;
  webHost: string;
  webAuthToken: string;
  webPushIntervalMs: number;
};

const DASHBOARD_DEFAULTS = {
  webPort: 3000,
  webHost: "127.0.0.1",
  webPushIntervalMs: 5000,
} as const;

/**
 * Parse dashboard-related environment variables into a typed config object.
 * Invalid numeric values silently fall back to defaults.
 */
export function loadDashboardConfig(
  env: Record<string, string | undefined>,
): DashboardConfig {
  return {
    webPort: parseNumericEnv(env["WEB_PORT"], DASHBOARD_DEFAULTS.webPort),
    webHost: env["WEB_HOST"]?.trim() || DASHBOARD_DEFAULTS.webHost,
    webAuthToken: env["WEB_AUTH_TOKEN"]?.trim() ?? "",
    webPushIntervalMs: parseNumericEnv(
      env["WEB_PUSH_INTERVAL_MS"],
      DASHBOARD_DEFAULTS.webPushIntervalMs,
    ),
  };
}

/**
 * Validate that the dashboard config is usable when `--web` is enabled.
 * Throws if `WEB_AUTH_TOKEN` is missing.
 */
export function validateDashboardConfig(
  config: DashboardConfig,
  webEnabled: boolean,
): void {
  if (webEnabled && !config.webAuthToken) {
    throw new Error(
      "WEB_AUTH_TOKEN is required when --web is enabled",
    );
  }
}

// ── Data Models ─────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { TrafficEntry } from "./agent-api-server.js";
import { localIso } from "./logger.js";

export type StatusSnapshot = {
  timestamp: string;
  uptimeMs: number;
  platforms: PlatformStates;
  services: Record<string, { configured: boolean; running: boolean }>;
  transport: TransportStatus;
  memory: MemoryStatus;
  heartbeat: HeartbeatStatus;
  cron: CronEntryStatus[];
  notebooklm: { enabled: boolean } | null;
  gwsAuth: boolean;
  agentApi: { traffic: TrafficEntry[] } | null;
};

export type CronEntryStatus = {
  id: string;
  label: string;
  schedule: string;
  executor: "agent" | "script";
  fireAt: number;
  paused: boolean;
  lastRanAt?: number;
  lastExitCode?: number | null;
  priority?: "high" | "medium" | "low";
};

export type PlatformStates = {
  telegram: { configured: boolean; running: boolean };
  discord: { configured: boolean; running: boolean };
};

export type TransportStatus = {
  type: "tmux" | "acp";
  ready: boolean;
  contextPercent: number;
};

export type MemoryStatus = {
  enabled: boolean;
  stats: {
    totalMessages: number;
    extractedMemories: number;
    extractedByType: Record<string, number>;
    preservedKeywords: number;
    consolidationFiles: { daily: number; weekly: number; quarterly: number };
    ingestedDocuments: number;
    dbSizeBytes: number;
  } | null;
  error?: string;
};

export type HeartbeatStatus = {
  running: boolean;
  intervalMs: number;
  taskNames: string[];
};

// ── Memory Search Types ─────────────────────────────────────────────────────

export type WebSearchResult = {
  content: string;
  date: string;
  source: string;
  score: number;
  // Rich attributes (L2 extracted memories only)
  contentOriginal?: string;
  memoryType?: string;
  emotionScore?: number;
  classification?: number;
  trust?: number;
  integrity?: number;
  credibility?: number;
  recallCount?: number;
  relevanceScore?: number;
  preserveOriginal?: boolean;
};

export type MemorySearchResponse = {
  results: WebSearchResult[];
  layers: Record<string, { status: string; hits?: number; ms?: number }>;
};

// ── Snapshot Builder ────────────────────────────────────────────────────────

/**
 * Refs to subsystems used for building a StatusSnapshot.
 * All fields are nullable to handle disabled/unconfigured subsystems.
 */
export type SubsystemRefs = {
  startedAt: number;
  telegramPoller: { running: boolean } | null;
  discordPoller: { started: boolean } | null;
  services: Record<string, { configured: boolean; running: boolean }>;
  transport: {
    type: "tmux" | "acp";
    isReady: boolean;
    contextPercent?: number;
  };
  memory: {
    getStats: (chatId?: number) => {
      totalMessages: number;
      extractedMemories: number;
      extractedByType: Record<string, number>;
      preservedKeywords: number;
      consolidationFiles: { daily: number; weekly: number; quarterly: number };
      ingestedDocuments: number;
      dbSizeBytes: number;
    } | null;
  } | null;
  heartbeat: {
    running: boolean;
    intervalMs: number;
    tasks: { name: string }[];
  } | null;
  chatId?: number;
  notebooklm: boolean;
  agentApi: { getTrafficLog: () => TrafficEntry[] } | null;
};

/**
 * Build a complete StatusSnapshot from subsystem refs.
 * Handles disabled subsystems and getStats() errors gracefully:
 * - When memory is null → enabled: false, stats: null
 * - When getStats() throws → includes error field, stats: null
 * - Other subsystem data is always included regardless of errors
 */
export function buildStatusSnapshot(refs: SubsystemRefs): StatusSnapshot {
  const now = Date.now();

  // Platforms
  const platforms: PlatformStates = {
    telegram: {
      configured: refs.telegramPoller !== null,
      running: refs.telegramPoller?.running ?? false,
    },
    discord: {
      configured: refs.discordPoller !== null,
      running: refs.discordPoller?.started ?? false,
    },
  };

  // Transport
  const transport: TransportStatus = {
    type: refs.transport.type,
    ready: refs.transport.isReady,
    contextPercent: Math.ceil(refs.transport.contextPercent ?? -1),
  };

  // Memory
  let memory: MemoryStatus;
  if (refs.memory === null) {
    memory = { enabled: false, stats: null };
  } else {
    try {
      const raw = refs.memory.getStats(refs.chatId);
      memory = { enabled: true, stats: raw };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      memory = { enabled: true, stats: null, error: msg };
    }
  }

  // Heartbeat
  const heartbeat: HeartbeatStatus = refs.heartbeat
    ? {
        running: refs.heartbeat.running,
        intervalMs: refs.heartbeat.intervalMs,
        taskNames: refs.heartbeat.tasks.map((t) => t.name),
      }
    : { running: false, intervalMs: 0, taskNames: [] };

  return {
    timestamp: localIso(),
    uptimeMs: now - refs.startedAt,
    platforms,
    services: refs.services,
    transport,
    memory,
    heartbeat,
    cron: readCronStatus(),
    notebooklm: refs.notebooklm ? { enabled: true } : null,
    gwsAuth: existsSync(resolve(homedir(), ".config", "gws", "credentials.enc")),
    agentApi: refs.agentApi ? { traffic: refs.agentApi.getTrafficLog() } : null,
  };
}

import { readEntries as readCronEntries } from "./cron-db.js";

function readCronStatus(): CronEntryStatus[] {
  try {
    const raw = readCronEntries();
    return raw
      .filter((e) => e.schedule)
      .map((e) => {
        const firstLine = (e.message ?? "").split("\n")[0] ?? "";
        const label = firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
        const hist = e.history ?? [];
        const last = hist.length > 0 ? hist[hist.length - 1] : undefined;
        return {
          id: e.id,
          label: label || e.id,
          schedule: e.schedule!,
          executor: e.executor ?? "script",
          fireAt: e.fireAt,
          paused: Boolean(e.paused),
          lastRanAt: e.lastRanAt,
          lastExitCode: last?.exitCode ?? null,
          ...(e.priority ? { priority: e.priority } : {}),
        };
      });
  } catch {
    return [];
  }
}

// ── Utility Functions ───────────────────────────────────────────────────────

/**
 * Format a millisecond duration into a human-readable uptime string.
 * Example: 7_530_000 → "2h 5m 30s"
 */
export function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}

// ── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Parse a string as a finite positive integer, falling back to `fallback`.
 */
function parseNumericEnv(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
