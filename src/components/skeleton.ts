/**
 * ABSkeleton — typed slot interfaces for Abtars's modular architecture.
 * Each slot has a specific contract. Implementations are swappable.
 */

import type { IMemorySystem } from "abmind";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { SubagentRuntime } from "./subagent-runtime.js";
import type { StatusSnapshot } from "../types/status.js";

// ── Slot interfaces ─────────────────────────────────────────────────────────

/** Task scheduler slot — heartbeat tick loop or message queue. */
export interface ITaskSlot {
  registerTask(task: { name: string; heavy?: boolean; execute: () => Promise<boolean | void> }): void;
  start(): void;
  stop(): void;
  getTaskNames(): string[];
  getTaskStatuses(): ReadonlyMap<string, string>;
  readonly intervalMs: number;
}

/** Skill loader slot — markdown files or MCP server. */
export interface ISkillSlot {
  /** Scan for new/changed skills since last check. */
  checkForChanges(): Array<{ filename: string; name: string; description: string; path: string }>;
  /** Append skill to tools manifest. */
  generateCatalog(): void;
}

/** Platform adapter slot — Telegram, Discord, etc. */
export interface IPlatformSlot {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Dashboard slot — web UI, Grafana exporter, mobile push, etc. */
export interface IDashboardSlot {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Options passed to custom dashboard implementations. */
export interface DashboardSlotOpts {
  getStatus: () => StatusSnapshot;
  port: number;
  host: string;
  authToken: string;
}

// ── Skeleton ────────────────────────────────────────────────────────────────

export interface ABSkeleton {
  memory: IMemorySystem;
  transport: IKiroTransport;
  runtime: SubagentRuntime;
  tasks: ITaskSlot;
  skills: ISkillSlot;
  dashboard: IDashboardSlot | null;
  platforms: IPlatformSlot[];
}
