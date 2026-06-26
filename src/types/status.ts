/** Bridge status types — used by dashboard slot implementations. */

import type { TrafficEntry } from "../components/agent-api-server.js";

export type StatusSnapshot = {
  timestamp: string;
  uptimeMs: number;
  version: string;
  commit: string;
  platforms: PlatformStates;
  services: Record<string, { configured: boolean; running: boolean }>;
  transport: TransportStatus;
  memory: MemoryStatus;
  heartbeat: HeartbeatStatus;
  cron: CronEntryStatus[];
  notebooklm: { enabled: boolean } | null;
  gwsAuth: boolean;
  xAuth: boolean;
  agentApi: { traffic: TrafficEntry[] } | null;
  model: ModelStatus;
  subsystems: SubsystemStatus[];
};

export type CronEntryStatus = {
  id: string;
  label: string;
  schedule: string;
  executor: "agent" | "script" | "orc";
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
  type: "tmux" | "acp" | "api";
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

export type WebSearchResult = {
  content: string;
  date: string;
  source: string;
  score: number;
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

export type ModelStatus = {
  name: string;
  provider: string;
  fallbackChain: string[];
};

export type SubsystemStatus = {
  name: string;
  status: "ok" | "failed" | "skipped" | "stopped" | "retrying";
  detail?: string;
};
