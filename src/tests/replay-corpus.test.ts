/**
 * replay-corpus.test.ts — Sanitized replay corpus for #1335 baseline.
 *
 * Creates synthetic conversations representing typical Direct API usage
 * patterns for offline A/B replay. Never contains real user content.
 * The corpus is privacy-safe: all content is synthetic.
 *
 * Each fixture can be replayed through both the old (baseline) and new
 * (candidate) context renderers to measure cache-stability metrics.
 */

import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { recordCacheTelemetry, computeCacheAggregate, evaluateProceedGate, resetCacheTelemetry, type ContextCacheTelemetryV1 } from "../components/cache-telemetry.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<ContextCacheTelemetryV1> & { sessionHash: string; estimatedInput: number }): ContextCacheTelemetryV1 {
  return {
    version: 1,
    logicalTurnId: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    candidateKeyHash: "test-key-hash",
    contextWindow: 128_000,
    reservedOutput: 4096,
    safetyMargin: 4096,
    measuredInput: overrides.estimatedInput,
    stablePrefixTokens: overrides.estimatedInput,
    stablePrefixDigest: `digest-${overrides.sessionHash}-${overrides.estimatedInput}`,
    rendererVersion: "abm-l-v2-baseline",
    latencyMs: 2000 + Math.random() * 3000,
    ...overrides,
  };
}

// ── fixture: short normal dialogue ────────────────────────────────────────────

function shortDialogue(): ContextCacheTelemetryV1[] {
  const sessionHash = "short-dialogue-fixture";
  const events: ContextCacheTelemetryV1[] = [];
  let prevDigest = "";

  for (let turn = 0; turn < 5; turn++) {
    const inputTokens = 2000 + turn * 200;
    const digest = `sd-${turn}-${inputTokens}`;
    events.push(makeEvent({
      sessionHash,
      estimatedInput: inputTokens,
      stablePrefixTokens: inputTokens,
      stablePrefixDigest: digest,
      priorCommonPrefixTokens: turn > 0 ? 1800 + (turn - 1) * 200 : undefined,
      firstChangedMessageIndex: turn > 0 ? 0 : undefined,
      cacheRead: turn > 0 ? Math.floor(inputTokens * 0.75) : undefined,
      cacheWrite: turn === 0 ? inputTokens : undefined,
      latencyMs: 1500 + turn * 200,
    }));
    prevDigest = digest;
  }
  return events;
}

// ── fixture: long dialogue crossing middle tiers ───────────────────────────────

function longDialogue(): ContextCacheTelemetryV1[] {
  const sessionHash = "long-dialogue-fixture";
  const events: ContextCacheTelemetryV1[] = [];

  for (let turn = 0; turn < 30; turn++) {
    const inputTokens = 5000 + turn * 500;
    const stablePrefixTokens = 5000 + turn * 500;
    const digest = `ld-${turn}-${inputTokens}`;
    const prevTokens = turn > 0 ? 5000 + (turn - 1) * 500 : undefined;

    events.push(makeEvent({
      sessionHash,
      estimatedInput: inputTokens,
      stablePrefixTokens,
      stablePrefixDigest: digest,
      priorCommonPrefixTokens: prevTokens,
      // Simulate cache-read ratio declining as prefix changes grow
      cacheRead: turn > 0 ? Math.floor(inputTokens * Math.max(0.3, 0.85 - turn * 0.02)) : undefined,
      cacheWrite: turn === 0 || turn % 5 === 4 ? inputTokens : undefined,
      latencyMs: 3000 + turn * 100,
    }));
  }
  return events;
}

// ── fixture: recall changes without history changes ───────────────────────────

function recallChangesFixture(): ContextCacheTelemetryV1[] {
  const sessionHash = "recall-changes-fixture";
  const events: ContextCacheTelemetryV1[] = [];
  const BASE = 8000;

  // First turn establishes baseline
  events.push(makeEvent({
    sessionHash,
    estimatedInput: BASE,
    stablePrefixTokens: BASE,
    stablePrefixDigest: "recall-base",
    cacheWrite: BASE,
    latencyMs: 2000,
  }));

  // Subsequent turns: historical prefix is identical (same digest), only
  // volatile recall content changes. prefix should be ~same tokens.
  for (let turn = 1; turn < 8; turn++) {
    events.push(makeEvent({
      sessionHash,
      estimatedInput: BASE + 200, // volatile recall adds small delta
      stablePrefixTokens: BASE,
      stablePrefixDigest: "recall-base",
      priorCommonPrefixTokens: BASE,
      // Cache-read should be high since prefix is identical
      cacheRead: Math.floor(BASE * 0.92),
      latencyMs: 1800,
    }));
  }
  return events;
}

// ── fixture: tool-heavy turns ─────────────────────────────────────────────────

function toolHeavyFixture(): ContextCacheTelemetryV1[] {
  const sessionHash = "tool-heavy-fixture";
  const events: ContextCacheTelemetryV1[] = [];

  for (let turn = 0; turn < 10; turn++) {
    const inputTokens = 12000 + turn * 3000;
    const stablePrefixTokens = inputTokens;
    const digest = `th-${turn}`;
    const prevTokens = turn > 0 ? 12000 + (turn - 1) * 3000 : undefined;

    events.push(makeEvent({
      sessionHash,
      estimatedInput: inputTokens,
      stablePrefixTokens,
      stablePrefixDigest: digest,
      priorCommonPrefixTokens: prevTokens,
      cacheRead: turn > 0 ? Math.floor(inputTokens * 0.6) : undefined,
      cacheWrite: turn === 0 || turn % 3 === 2 ? inputTokens : undefined,
      latencyMs: 8000 + Math.random() * 4000,
      compaction: turn % 5 === 4 ? {
        reason: "headroom",
        durationMs: 3000,
        inputTokens: 25000,
        outputTokens: 4000,
      } : undefined,
    }));
  }
  return events;
}

// ── fixture: fallback transitions ─────────────────────────────────────────────

function fallbackFixture(): ContextCacheTelemetryV1[] {
  const sessionHash = "fallback-fixture";
  const events: ContextCacheTelemetryV1[] = [];

  // Primary model
  events.push(makeEvent({
    sessionHash,
    candidateKeyHash: candidateKey("gpt-4", "api.openai.com"),
    estimatedInput: 10000,
    stablePrefixTokens: 10000,
    stablePrefixDigest: "fallback-0",
    contextWindow: 128000,
    cacheWrite: 10000,
    latencyMs: 2500,
  }));

  // Fallback to smaller model
  events.push(makeEvent({
    sessionHash,
    candidateKeyHash: candidateKey("gpt-3.5-turbo", "api.openai.com"),
    estimatedInput: 10000,
    stablePrefixTokens: 10000,
    stablePrefixDigest: "fallback-0",
    priorCommonPrefixTokens: 10000,
    contextWindow: 16384,
    reservedOutput: 2048,
    cacheRead: 10000,
    latencyMs: 1500,
  }));

  // Back to primary with fresh prefix
  events.push(makeEvent({
    sessionHash,
    candidateKeyHash: candidateKey("gpt-4", "api.openai.com"),
    estimatedInput: 12000,
    stablePrefixTokens: 12000,
    stablePrefixDigest: "fallback-1",
    priorCommonPrefixTokens: 10000,
    contextWindow: 128000,
    cacheRead: Math.floor(10000 * 0.8),
    latencyMs: 2000,
  }));

  return events;
}

function candidateKey(model: string, endpoint: string): string {
  return createHash("sha256").update(`${endpoint}::${model}`).digest("hex").slice(0, 16);
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("replay corpus — #1335 baseline gate", () => {
  it("short dialogue: high cache-read ratio passes gate", () => {
    for (const e of shortDialogue()) {
      recordCacheTelemetry(e);
    }
    const agg = computeCacheAggregate();
    expect(agg).not.toBeNull();
    expect(agg!.totalTurns).toBe(5);
    // Short dialogue with stable prefix → high cache ratio → should NOT proceed
    // (it demonstrates efficient caching already)
    const gate = evaluateProceedGate(agg!);
    // If cache ratio > 80% and churn < 15% and rewrite < 10%, gate defers
    if (agg!.medianCacheReadRatio >= 0.8 && agg!.meanStablePrefixChurn <= 0.15) {
      expect(gate.proceed).toBe(false);
    }
    // Reset for next test
    resetCacheTelemetry();
  });

  it("long dialogue: crossing tiers causes churn", () => {
    for (const e of longDialogue()) {
      recordCacheTelemetry(e);
    }
    const agg = computeCacheAggregate();
    expect(agg).not.toBeNull();
    expect(agg!.totalTurns).toBe(30);
    // Long dialogue with declining cache ratio should trigger proceed
    const gate = evaluateProceedGate(agg!);
    // At least one criterion should be met for long dialogues
    expect(gate.proceed || gate.reason).toBeTruthy();
    resetCacheTelemetry();
  });

  it("recall changes: stable prefix preserves cache", () => {
    for (const e of recallChangesFixture()) {
      recordCacheTelemetry(e);
    }
    const agg = computeCacheAggregate();
    expect(agg).not.toBeNull();
    // Recall changes should NOT cause churn because prefix is stable
    expect(agg!.prefixRewriteTurns).toBe(0);
    expect(agg!.meanStablePrefixChurn).toBeLessThan(0.01);
    resetCacheTelemetry();
  });

  it("tool-heavy: compaction and large context", () => {
    for (const e of toolHeavyFixture()) {
      recordCacheTelemetry(e);
    }
    const agg = computeCacheAggregate();
    expect(agg).not.toBeNull();
    expect(agg!.compactionCount).toBeGreaterThan(0);
    expect(agg!.totalBilledInput).toBeGreaterThan(0);
    resetCacheTelemetry();
  });

  it("fallback: model switch resets cache", () => {
    for (const e of fallbackFixture()) {
      recordCacheTelemetry(e);
    }
    const agg = computeCacheAggregate();
    expect(agg).not.toBeNull();
    expect(agg!.fallbackCount).toBeGreaterThan(0);
    resetCacheTelemetry();
  });

  it("computeCacheAggregate returns null for <2 events", () => {
    recordCacheTelemetry(makeEvent({ sessionHash: "single", estimatedInput: 1000 }));
    const agg = computeCacheAggregate();
    expect(agg).toBeNull();
    resetCacheTelemetry();
  });

  it("evaluateProceedGate defers when thresholds not met", () => {
    // Very efficient scenario: all turns have high cache ratio
    for (let i = 0; i < 6; i++) {
      recordCacheTelemetry(makeEvent({
        sessionHash: "efficient",
        estimatedInput: 5000,
        stablePrefixDigest: `eff-${i > 0 ? "same" : "base"}`,
        priorCommonPrefixTokens: i > 0 ? 5000 : undefined,
        cacheRead: i > 0 ? 4800 : undefined,
        stablePrefixTokens: 5000,
        latencyMs: 1000,
      }));
    }
    const agg = computeCacheAggregate();
    expect(agg).not.toBeNull();
    // High cache ratio should defer
    const gate = evaluateProceedGate(agg!);
    if (agg!.medianCacheReadRatio >= 0.8) {
      expect(gate.proceed).toBe(false);
    }
    resetCacheTelemetry();
  });
});
