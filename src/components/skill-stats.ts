/**
 * skill-stats.ts — in-memory skill usage tracking with debounced disk flush (#613).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";
import { logAndSwallow } from "./log-and-swallow.js";

const TAG = "skill-stats";

export interface SkillStat {
  reads: number;
  lastRead: string;
  createdAt?: string;
  createdBy?: string;
}

const stats = new Map<string, SkillStat>();
let dirty = false;

function statsPath(): string { return join(abtarsHome(), "skills", ".stats.json"); }

export function init(): void {
  try {
    const p = statsPath();
    if (!existsSync(p)) return;
    const data = JSON.parse(readFileSync(p, "utf-8")) as Record<string, SkillStat>;
    for (const [k, v] of Object.entries(data)) stats.set(k, v);
  } catch (err) { logAndSwallow(TAG, "init", err); }
}

export function bumpRead(name: string): void {
  const existing = stats.get(name);
  const now = new Date().toISOString();
  if (existing) {
    existing.reads++;
    existing.lastRead = now;
  } else {
    stats.set(name, { reads: 1, lastRead: now });
  }
  dirty = true;
}

export function setProvenance(name: string, createdBy: string): void {
  const existing = stats.get(name);
  const now = new Date().toISOString();
  if (existing) {
    existing.createdAt = now;
    existing.createdBy = createdBy;
  } else {
    stats.set(name, { reads: 0, lastRead: now, createdAt: now, createdBy });
  }
  dirty = true;
}

export function flush(): void {
  if (!dirty) return;
  const dir = join(abtarsHome(), "skills");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const obj: Record<string, SkillStat> = {};
  for (const [k, v] of stats) obj[k] = v;
  writeFileSync(statsPath(), JSON.stringify(obj, null, 2) + "\n", "utf-8");
  dirty = false;
}

/** Exposed for testing. */
export function _getStats(): Map<string, SkillStat> { return stats; }
export function _reset(): void { stats.clear(); dirty = false; }
