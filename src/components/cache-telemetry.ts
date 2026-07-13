/**
 * cache-telemetry.ts — Privacy-safe cache/prefix/capacity/latency telemetry (#1335).
 *
 * Records per-turn cache-stability metrics for the baseline/replay corpus
 * (Task 1) and for ongoing A/B monitoring (Task 10). Never captures prompt
 * content, memory text, tool arguments/results, API keys, or provider
 * request bodies — only digests, counts, and IDs.
 *
 * Phase-zero baseline gate: if no proceed threshold is met, this module
 * records the defer decision and no checkpoint schema is created.
 * The telemetry infrastructure itself is always active when configured.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const RING_SIZE = 500;

// ── types ────────────────────────────────────────────────────────────────────

export interface ContextCacheTelemetryV1 {
  version: 1;
  sessionHash: string;
  logicalTurnId: string;
  candidateKeyHash: string;
  contextWindow: number;
  reservedOutput: number;
  safetyMargin: number;
  estimatedInput: number;
  measuredInput?: number;
  cacheRead?: number;
  cacheWrite?: number;
  stablePrefixTokens: number;
  stablePrefixDigest: string;
  priorCommonPrefixTokens?: number;
  firstChangedMessageIndex?: number;
  latencyMs: number;
  compaction?: {
    reason: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
  };
  rendererVersion: string;
}

export interface CacheTelemetryAggregate {
  totalTurns: number;
  warmTurns: number;
  medianCacheReadRatio: number;
  p75CacheReadRatio: number;
  meanStablePrefixChurn: number;
  prefixRewriteTurns: number;
  totalUncachedInput: number;
  totalBilledInput: number;
  totalLatencyMs: number;
  compactionCount: number;
  fallbackCount: number;
}

// ── ring buffer ──────────────────────────────────────────────────────────────

let telemetryEvents: ContextCacheTelemetryV1[] = [];
let telemetryPath = "";

export function initCacheTelemetry(home: string): void {
  const metricsDir = join(home, "metrics");
  if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });
  telemetryPath = join(metricsDir, "cache-telemetry.jsonl");
}

export function recordCacheTelemetry(event: ContextCacheTelemetryV1): void {
  telemetryEvents.push(event);
  if (telemetryEvents.length >= RING_SIZE) flushCacheTelemetry();
  if (telemetryPath) {
    try { appendFileSync(telemetryPath, JSON.stringify(event) + "\n"); }
    catch { /* non-fatal */ }
  }
}

export function flushCacheTelemetry(): void {
  // Ring buffer is kept for in-memory aggregation; persisted events are
  // written individually in recordCacheTelemetry.
  if (telemetryEvents.length > RING_SIZE) {
    telemetryEvents = telemetryEvents.slice(-RING_SIZE);
  }
}

export function getCacheTelemetryEvents(): ContextCacheTelemetryV1[] {
  return [...telemetryEvents];
}

/**
 * Compute aggregate metrics from in-memory events.
 * Returns null when fewer than 2 events exist.
 */
export function computeCacheAggregate(): CacheTelemetryAggregate | null {
  if (telemetryEvents.length < 2) return null;

  const events = telemetryEvents;
  const totalTurns = events.length;

  // Warm turns: those with a priorCommonPrefixTokens value
  const warmTurns = events.filter(e => e.priorCommonPrefixTokens != null).length;

  // Cache-read ratios for warm turns (cacheRead / estimatedInput where cacheRead is available)
  const warmCacheRatios = events
    .filter(e => e.cacheRead != null && e.priorCommonPrefixTokens != null && e.estimatedInput > 0)
    .map(e => (e.cacheRead ?? 0) / e.estimatedInput)
    .sort((a, b) => a - b);

  const medianCacheReadRatio = warmCacheRatios.length > 0
    ? warmCacheRatios[Math.floor(warmCacheRatios.length * 0.5)]!
    : 0;
  const p75CacheReadRatio = warmCacheRatios.length > 0
    ? warmCacheRatios[Math.floor(warmCacheRatios.length * 0.75)]!
    : 0;

  // Stable-prefix churn: count of events where the prefix is smaller than expected
  const meanStablePrefixChurn = events.reduce((s, e) => {
    const prior = e.priorCommonPrefixTokens;
    if (prior == null || prior === 0) return s;
    return s + Math.max(0, prior - (e.stablePrefixTokens ?? 0)) / prior;
  }, 0) / Math.max(1, events.filter(e => e.priorCommonPrefixTokens != null && e.priorCommonPrefixTokens > 0).length);

  const prefixRewriteTurns = events.filter(e =>
    e.priorCommonPrefixTokens != null &&
    e.priorCommonPrefixTokens > 0 &&
    e.stablePrefixTokens < e.priorCommonPrefixTokens * 0.9
  ).length;

  const totalUncachedInput = events.reduce((s, e) => s + (e.estimatedInput - (e.cacheRead ?? 0)), 0);
  const totalBilledInput = events.reduce((s, e) => s + e.estimatedInput, 0);
  const totalLatencyMs = events.reduce((s, e) => s + e.latencyMs, 0);
  const compactionCount = events.filter(e => e.compaction != null).length;
  const fallbackCount = events.filter(e => e.candidateKeyHash !== "").length; // simplified

  return {
    totalTurns,
    warmTurns,
    medianCacheReadRatio,
    p75CacheReadRatio,
    meanStablePrefixChurn,
    prefixRewriteTurns,
    totalUncachedInput,
    totalBilledInput,
    totalLatencyMs,
    compactionCount,
    fallbackCount,
  };
}

/**
 * Evaluate the phase-zero evidence-gate thresholds.
 * Returns { proceed: true } if any criterion is met, or { proceed: false, reason }
 * if the implementation should be deferred.
 */
export function evaluateProceedGate(agg: CacheTelemetryAggregate): { proceed: boolean; reason?: string } {
  if (agg.warmTurns < 5) {
    return { proceed: false, reason: `Insufficient warm turns (${agg.warmTurns} < 5) for stable evaluation` };
  }

  if (agg.medianCacheReadRatio < 0.8 && agg.warmTurns >= 10) {
    return { proceed: true, reason: `Median warm-turn cache-read ratio ${(agg.medianCacheReadRatio * 100).toFixed(1)}% < 80% — avoidable churn detected` };
  }

  const rewritePct = agg.totalTurns > 0 ? (agg.prefixRewriteTurns / agg.totalTurns) * 100 : 0;
  if (rewritePct > 10) {
    return { proceed: true, reason: `${rewritePct.toFixed(1)}% of turns rewrite historical prefix >10%` };
  }

  if (agg.meanStablePrefixChurn > 0.15) {
    return { proceed: true, reason: `Mean stable-prefix churn ${(agg.meanStablePrefixChurn * 100).toFixed(1)}% > 15%` };
  }

  return {
    proceed: false,
    reason: `No threshold met: median-cache-ratio=${(agg.medianCacheReadRatio * 100).toFixed(1)}%, prefix-rewrite=${rewritePct.toFixed(1)}%, mean-churn=${(agg.meanStablePrefixChurn * 100).toFixed(1)}%`,
  };
}

// ── test support ─────────────────────────────────────────────────────────────

/** Reset in-memory buffer (for test isolation). */
export function resetCacheTelemetry(): void {
  telemetryEvents = [];
}

// ── clean-up ─────────────────────────────────────────────────────────────────

export function pruneCacheTelemetryFile(): void {
  if (!telemetryPath || !existsSync(telemetryPath)) return;
  try {
    const lines = readFileSync(telemetryPath, "utf-8").split("\n").filter(Boolean);
    const kept = lines.filter(line => {
      try { return JSON.parse(line).latencyMs > 0 || true; } catch { return false; }
    });
    writeFileSync(telemetryPath, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
  } catch { /* non-fatal */ }
}

// ── hashing helpers ──────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

export function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function sessionHash(sessionKey: string): string {
  return stableHash(sessionKey);
}

export function candidateKeyHash(endpoint: string, model: string): string {
  return stableHash(`${endpoint}::${model}`);
}
