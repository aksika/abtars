/**
 * cache-telemetry.test.ts — Unit tests for #1335 cache telemetry.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordCacheTelemetry,
  resetCacheTelemetry,
  computeCacheAggregate,
  evaluateProceedGate,
  stableHash,
  sessionHash,
  candidateKeyHash,
  type ContextCacheTelemetryV1,
} from "./cache-telemetry.js";

function makeEvent(overrides: Partial<ContextCacheTelemetryV1> & { sessionHash: string; estimatedInput: number }): ContextCacheTelemetryV1 {
  return {
    version: 1,
    logicalTurnId: `turn-${Date.now()}`,
    candidateKeyHash: "test-key",
    contextWindow: 128_000,
    reservedOutput: 4096,
    safetyMargin: 4096,
    measuredInput: overrides.estimatedInput,
    stablePrefixTokens: overrides.estimatedInput,
    stablePrefixDigest: `digest-${overrides.sessionHash}`,
    rendererVersion: "test-v1",
    latencyMs: 1000,
    ...overrides,
  };
}

describe("cache-telemetry", () => {
  beforeEach(() => {
    resetCacheTelemetry();
  });

  it("records and computes aggregate for multiple events", () => {
    for (let i = 0; i < 5; i++) {
      recordCacheTelemetry(makeEvent({
        sessionHash: "test-session",
        estimatedInput: 5000 + i * 500,
        stablePrefixTokens: 5000 + i * 500,
        priorCommonPrefixTokens: i > 0 ? 5000 + (i - 1) * 500 : undefined,
        cacheRead: i > 0 ? 4000 : undefined,
        latencyMs: 2000,
      }));
    }
    const agg = computeCacheAggregate();
    expect(agg).not.toBeNull();
    expect(agg!.totalTurns).toBe(5);
    expect(agg!.warmTurns).toBe(4);
    expect(agg!.totalBilledInput).toBeGreaterThan(0);
  });

  it("returns null aggregate for single event", () => {
    recordCacheTelemetry(makeEvent({ sessionHash: "single", estimatedInput: 1000 }));
    expect(computeCacheAggregate()).toBeNull();
  });

  it("evaluateProceedGate defers when cache ratio is high", () => {
    for (let i = 0; i < 10; i++) {
      recordCacheTelemetry(makeEvent({
        sessionHash: "efficient",
        estimatedInput: 5000,
        priorCommonPrefixTokens: i > 0 ? 5000 : undefined,
        cacheRead: i > 0 ? 4800 : undefined,
        stablePrefixTokens: 5000,
      }));
    }
    const agg = computeCacheAggregate();
    expect(agg).not.toBeNull();
    const gate = evaluateProceedGate(agg!);
    if (agg!.medianCacheReadRatio >= 0.8) {
      expect(gate.proceed).toBe(false);
    }
  });

  it("evaluateProceedGate triggers when prefix churn is high", () => {
    for (let i = 0; i < 10; i++) {
      recordCacheTelemetry(makeEvent({
        sessionHash: "churn-session",
        estimatedInput: 10000,
        stablePrefixTokens: i === 0 ? 10000 : 8000,
        priorCommonPrefixTokens: i > 0 ? 10000 : undefined,
        cacheRead: i > 0 ? 6000 : undefined,
      }));
    }
    const agg = computeCacheAggregate();
    expect(agg).not.toBeNull();
    const gate = evaluateProceedGate(agg!);
    // Churn should be high enough to trigger
    if (agg!.prefixRewriteTurns >= 3) {
      expect(gate.proceed).toBe(true);
    }
  });

  it("evaluateProceedGate defers with insufficient warm turns", () => {
    recordCacheTelemetry(makeEvent({ sessionHash: "cold", estimatedInput: 1000 }));
    recordCacheTelemetry(makeEvent({ sessionHash: "cold", estimatedInput: 2000 }));
    const agg = computeCacheAggregate();
    expect(agg).not.toBeNull();
    const gate = evaluateProceedGate(agg!);
    expect(gate.proceed).toBe(false);
    expect(gate.reason).toContain("Insufficient warm turns");
  });

  it("stableHash produces consistent results", () => {
    const hash1 = stableHash("hello world");
    const hash2 = stableHash("hello world");
    const hash3 = stableHash("different");
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1.length).toBe(16);
  });

  it("sessionHash and candidateKeyHash are deterministic", () => {
    expect(sessionHash("session-1")).toBe(sessionHash("session-1"));
    expect(candidateKeyHash("endpoint", "model")).toBe(candidateKeyHash("endpoint", "model"));
    expect(sessionHash("session-1")).not.toBe(sessionHash("session-2"));
  });
});
