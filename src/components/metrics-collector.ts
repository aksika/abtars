/**
 * metrics-collector.ts — Lightweight in-process metrics collection (#832).
 * Ring buffers for latencies, daily counters, JSONL persistence.
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const RING_SIZE = 100;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface LatencyBucket {
  samples: number[];
  idx: number;
}

interface DailyCounter {
  date: string;
  calls: number;
  failures: number;
}

const latencies = new Map<string, LatencyBucket>();
const counters = new Map<string, DailyCounter>();
let cronDepthSamples: number[] = [];
let metricsPath = "";

export function initMetrics(home: string): void {
  const metricsDir = join(home, "metrics");
  if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });
  metricsPath = join(metricsDir, "metrics.jsonl");
}

export function recordLatency(key: string, durationMs: number): void {
  let bucket = latencies.get(key);
  if (!bucket) { bucket = { samples: [], idx: 0 }; latencies.set(key, bucket); }
  if (bucket.samples.length < RING_SIZE) {
    bucket.samples.push(durationMs);
  } else {
    bucket.samples[bucket.idx] = durationMs;
  }
  bucket.idx = (bucket.idx + 1) % RING_SIZE;
}

export function recordCall(key: string, success: boolean): void {
  const today = new Date().toISOString().slice(0, 10);
  let c = counters.get(key);
  if (!c || c.date !== today) { c = { date: today, calls: 0, failures: 0 }; counters.set(key, c); }
  c.calls++;
  if (!success) c.failures++;
}

export function recordCronDepth(depth: number): void {
  if (cronDepthSamples.length >= RING_SIZE) cronDepthSamples.shift();
  cronDepthSamples.push(depth);
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(sorted.length * pct), sorted.length - 1);
  return sorted[idx]!;
}

export interface MetricsSummary {
  llm: Record<string, { p50: number; p95: number; max: number; calls: number; failures: number }>;
  recall: { p50: number; p95: number; calls: number } | null;
  cronDepth: { avg: number; max: number };
  sleep: { calls: number; failures: number } | null;
}

export function getMetricsSummary(): MetricsSummary {
  const llm: MetricsSummary["llm"] = {};

  // Include all keys that have latency OR counter data
  const llmKeys = new Set<string>();
  for (const key of latencies.keys()) { if (key.startsWith("llm:")) llmKeys.add(key.slice(4)); }
  for (const key of counters.keys()) { if (key.startsWith("llm:")) llmKeys.add(key.slice(4)); }

  for (const model of llmKeys) {
    const bucket = latencies.get(`llm:${model}`);
    const sorted = bucket ? [...bucket.samples].sort((a, b) => a - b) : [];
    const counter = counters.get(`llm:${model}`);
    llm[model] = {
      p50: Math.round(percentile(sorted, 0.5)),
      p95: Math.round(percentile(sorted, 0.95)),
      max: sorted.length > 0 ? Math.round(sorted[sorted.length - 1]!) : 0,
      calls: counter?.calls ?? 0,
      failures: counter?.failures ?? 0,
    };
  }

  let recall: MetricsSummary["recall"] = null;
  const recallBucket = latencies.get("recall");
  if (recallBucket && recallBucket.samples.length > 0) {
    const sorted = [...recallBucket.samples].sort((a, b) => a - b);
    recall = { p50: Math.round(percentile(sorted, 0.5)), p95: Math.round(percentile(sorted, 0.95)), calls: sorted.length };
  }

  const cronSorted = [...cronDepthSamples];
  const cronMax = cronSorted.length > 0 ? Math.max(...cronSorted) : 0;
  const cronAvg = cronSorted.length > 0 ? Math.round(cronSorted.reduce((a, b) => a + b, 0) / cronSorted.length) : 0;

  const sleepCounter = counters.get("sleep");
  const sleep = sleepCounter ? { calls: sleepCounter.calls, failures: sleepCounter.failures } : null;

  return { llm, recall, cronDepth: { avg: cronAvg, max: cronMax }, sleep };
}

export function flushToFile(): void {
  if (!metricsPath) return;
  try {
    const summary = getMetricsSummary();
    const line = JSON.stringify({ ts: Date.now(), ...summary }) + "\n";
    appendFileSync(metricsPath, line);
  } catch { /* non-fatal */ }
}

/** Housekeeping: remove lines older than 7 days. */
export function pruneMetricsFile(): void {
  if (!metricsPath || !existsSync(metricsPath)) return;
  try {
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    const lines = readFileSync(metricsPath, "utf-8").split("\n").filter(Boolean);
    const kept = lines.filter(line => {
      try { return JSON.parse(line).ts >= cutoff; } catch { return false; }
    });
    writeFileSync(metricsPath, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
  } catch { /* non-fatal */ }
}
