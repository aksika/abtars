/**
 * ABSkeleton — typed slot interfaces for AgentBridge's modular architecture.
 * Each slot has a specific contract. Implementations are swappable.
 */

import type { IMemorySystem } from "abmind/imemory-system.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { SubagentRuntime } from "./subagent-runtime.js";

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
  /** Load all skills from source. Returns map of skill name → content. */
  loadSkills(): Map<string, string>;
  /** Start watching for changes (hot-reload). */
  watch(): void;
  /** Stop watching. */
  stop(): void;
}

/** Platform adapter slot — Telegram, Discord, etc. */
export interface IPlatformSlot {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ── Skeleton ────────────────────────────────────────────────────────────────

export interface ABSkeleton {
  memory: IMemorySystem;
  transport: IKiroTransport;
  runtime: SubagentRuntime;
  tasks: ITaskSlot;
  skills: ISkillSlot;
  platforms: IPlatformSlot[];
}
