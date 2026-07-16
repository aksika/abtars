/**
 * Dashboard configuration, data models, and utility functions for the
 * abTARS Web UI.
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
    webAuthToken: env["WEB_AUTH"]?.trim() ?? "",
    webPushIntervalMs: parseNumericEnv(
      env["WEB_PUSH_INTERVAL_MS"],
      DASHBOARD_DEFAULTS.webPushIntervalMs,
    ),
  };
}

/**
 * Validate that the dashboard config is usable when `--web` is enabled.
 * Throws if `WEB_AUTH` is missing.
 */
export function validateDashboardConfig(
  config: DashboardConfig,
  webEnabled: boolean,
): void {
  if (webEnabled && !config.webAuthToken) {
    throw new Error(
      "WEB_AUTH is required when --web is enabled",
    );
  }
}

// ── Data Models ─────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { TrafficEntry } from "../agent-api-server.js";
import { localIso } from "../logger.js";
import { abtarsHome } from "../../paths.js";

export type {
  StatusSnapshot, CronEntryStatus, PlatformStates, TransportStatus,
  MemoryStatus, HeartbeatStatus, WebSearchResult, MemorySearchResponse,
} from "../../types/status.js";

import type {
  StatusSnapshot, CronEntryStatus, PlatformStates,
  TransportStatus, MemoryStatus, HeartbeatStatus,
} from "../../types/status.js";

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
    type: "tmux" | "acp" | "api";
    isReady: boolean;
    contextPercent?: number;
  };
  memory: {
    getStats: (userId?: string) => {
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
  userId?: string;
  notebooklm: boolean;
  agentApi: { getTrafficLog: () => TrafficEntry[] } | null;
  version?: string;
  commit?: string;
  model?: { name: string; provider: string; fallbackChain: string[] };
  subsystems?: Array<{ name: string; status: "ok" | "failed" | "skipped" | "stopped" | "retrying"; detail?: string }>;
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
      const raw = refs.memory.getStats(undefined);
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
    version: refs.version ?? "?",
    commit: refs.commit ?? "?",
    platforms,
    services: refs.services,
    transport,
    memory,
    heartbeat,
    cron: readCronStatus(),
    notebooklm: refs.notebooklm ? { enabled: true } : null,
    gwsAuth: existsSync(resolve(homedir(), ".config", "gws-cli", "token.json.enc")),
    xAuth: existsSync(resolve(abtarsHome(), "secret", "cookies", "x-cookies.json")),
    agentApi: refs.agentApi ? { traffic: refs.agentApi.getTrafficLog() } : null,
    model: refs.model ?? { name: "unknown", provider: "unknown", fallbackChain: [] },
    subsystems: refs.subsystems ?? [],
  };
}

import { readEntries as readCronEntries } from "../tasks/task-store.js";
import { readState } from "../tasks/task-state-store.js";
import { latestOutcomeByTask } from "../tasks/task-history-store.js";

function readCronStatus(): CronEntryStatus[] {
  try {
    const raw = readCronEntries();
    const outcomes = latestOutcomeByTask();
    return raw
      .filter((e) => e.schedule)
      .map((e) => {
        const state = readState(e.id);
        const last = outcomes.get(e.id);
        const label = e.kind === "agent" ? (e.prompt ?? e.taskFile ?? "").split("\n")[0] ?? "" : e.id;
        return {
          id: e.id,
          label: label.slice(0, 60) || e.id,
          schedule: e.schedule!,
          executor: e.kind,
          fireAt: state?.nextRunAt ?? 0,
          paused: state?.autoPaused ?? false,
          lastRanAt: state?.lastFinishedAt,
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
