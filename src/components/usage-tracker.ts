/**
 * usage-tracker.ts — append-only token usage log + aggregation.
 * Storage: ~/.abtars/metrics/usage.jsonl (one JSON line per prompt).
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface UsageEntry {
  ts: number;
  model: string;
  agent: string;
  in: number;
  out: number;
  /** #1311 C6: prompt-cache breakdown (pi-ai path; absent on L0 / legacy entries). */
  cacheRead?: number;
  cacheWrite?: number;
}

let buffer: UsageEntry[] = [];
let usagePath = "";
let _totalTokens = 0;

/** Cumulative token counter (input + output). Monotonically increasing. */
export function getTotalTokens(): number { return _totalTokens; }

export function initUsageTracker(home: string): void {
  const metricsDir = join(home, "metrics");
  if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });
  usagePath = join(metricsDir, "usage.jsonl");
}

/**
 * Record one prompt's usage. `in`/`out` are TOTAL token throughput (on the pi path `in` is
 * total input-side incl cache, per #1311/R1) — the budget counts `in+out` = totalTokens.
 * `cache` is the prompt-cache breakdown, stored for cache-aware cost + /usage display only;
 * it is never added to totals (it is a subset of `in`).
 */
export function recordUsage(model: string, inputTokens: number, outputTokens: number, agent = "", cache?: { cacheRead?: number; cacheWrite?: number }): void {
  _totalTokens += inputTokens + outputTokens;
  if (agent) {
    import("./budget.js").then(({ incrementBudgetCounter }) => incrementBudgetCounter(agent, inputTokens + outputTokens)).catch(() => {});
  }
  if (!usagePath) return;
  buffer.push({ ts: Date.now(), model, agent, in: inputTokens, out: outputTokens, cacheRead: cache?.cacheRead, cacheWrite: cache?.cacheWrite });
  if (buffer.length >= 100) flushUsage();
}

export function flushUsage(): void {
  if (!usagePath || buffer.length === 0) return;
  const lines = buffer.map(e => JSON.stringify(e)).join("\n") + "\n";
  appendFileSync(usagePath, lines);
  buffer = [];
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  byModel: Map<string, { in: number; out: number; cacheRead: number; cacheWrite: number; cost: number }>;
}

/** Cost resolver: given a raw entry, return its USD cost. Encodes pi-cache-aware vs models.json pricing. */
export type CostResolver = (e: { model: string; in: number; out: number; cacheRead?: number; cacheWrite?: number }) => number;

export function readUsage(since: number, costOf: CostResolver): UsageSummary {
  const result: UsageSummary = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, byModel: new Map() };
  if (!usagePath) return result;

  // Include unflushed buffer
  const entries: UsageEntry[] = [...buffer];

  if (existsSync(usagePath)) {
    const raw = readFileSync(usagePath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }

  for (const e of entries) {
    if (e.ts < since) continue;
    result.inputTokens += e.in;
    result.outputTokens += e.out;
    result.cacheRead += e.cacheRead ?? 0;
    result.cacheWrite += e.cacheWrite ?? 0;
    const entryCost = costOf(e);
    result.cost += entryCost;

    const existing = result.byModel.get(e.model);
    if (existing) {
      existing.in += e.in;
      existing.out += e.out;
      existing.cacheRead += e.cacheRead ?? 0;
      existing.cacheWrite += e.cacheWrite ?? 0;
      existing.cost += entryCost;
    } else {
      result.byModel.set(e.model, { in: e.in, out: e.out, cacheRead: e.cacheRead ?? 0, cacheWrite: e.cacheWrite ?? 0, cost: entryCost });
    }
  }
  return result;
}

export function resetUsage(): void {
  if (!usagePath) return;
  buffer = [];
  writeFileSync(usagePath, "");
}
