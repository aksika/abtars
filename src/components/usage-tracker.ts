/**
 * usage-tracker.ts — append-only token usage log + aggregation.
 * Storage: ~/.abtars/state/usage.jsonl (one JSON line per prompt).
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface UsageEntry {
  ts: number;
  model: string;
  in: number;
  out: number;
}

let buffer: UsageEntry[] = [];
let usagePath = "";

export function initUsageTracker(home: string): void {
  const stateDir = join(home, "state");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  usagePath = join(stateDir, "usage.jsonl");
}

export function recordUsage(model: string, inputTokens: number, outputTokens: number): void {
  if (!usagePath) return;
  buffer.push({ ts: Date.now(), model, in: inputTokens, out: outputTokens });
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
  cost: number;
  byModel: Map<string, { in: number; out: number; cost: number }>;
}

export function readUsage(since: number, costTable: Map<string, { input: number; output: number }>): UsageSummary {
  const result: UsageSummary = { inputTokens: 0, outputTokens: 0, cost: 0, byModel: new Map() };
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
    const pricing = costTable.get(e.model);
    const entryCost = pricing
      ? (e.in * pricing.input + e.out * pricing.output) / 1_000_000
      : 0;
    result.cost += entryCost;

    const existing = result.byModel.get(e.model);
    if (existing) {
      existing.in += e.in;
      existing.out += e.out;
      existing.cost += entryCost;
    } else {
      result.byModel.set(e.model, { in: e.in, out: e.out, cost: entryCost });
    }
  }
  return result;
}

export function resetUsage(): void {
  if (!usagePath) return;
  buffer = [];
  writeFileSync(usagePath, "");
}
