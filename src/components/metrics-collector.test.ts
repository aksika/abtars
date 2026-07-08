import { describe, it, expect, beforeEach } from "vitest";
import { recordLatency, recordCall, recordCronDepth, recordCompaction, getMetricsSummary, initMetrics, flushToFile, pruneMetricsFile } from "./metrics-collector.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionEvent } from "abmind";

describe("metrics-collector", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "metrics-test-"));
    initMetrics(tmp);
  });

  it("records LLM latency and computes percentiles", () => {
    for (let i = 1; i <= 100; i++) recordLatency("llm:gpt-4", i * 10);
    const s = getMetricsSummary();
    expect(s.llm["gpt-4"]).toBeDefined();
    expect(s.llm["gpt-4"]!.p50).toBeGreaterThanOrEqual(490);
    expect(s.llm["gpt-4"]!.p50).toBeLessThanOrEqual(510);
    expect(s.llm["gpt-4"]!.p95).toBeGreaterThanOrEqual(940);
    expect(s.llm["gpt-4"]!.p95).toBeLessThanOrEqual(960);
    expect(s.llm["gpt-4"]!.max).toBe(1000);
  });

  it("records call counts and failures", () => {
    recordCall("llm:claude", true);
    recordCall("llm:claude", true);
    recordCall("llm:claude", false);
    const s = getMetricsSummary();
    expect(s.llm["claude"]!.calls).toBe(3);
    expect(s.llm["claude"]!.failures).toBe(1);
  });

  it("records recall latency", () => {
    recordLatency("recall", 45);
    recordLatency("recall", 120);
    recordLatency("recall", 80);
    const s = getMetricsSummary();
    expect(s.recall).not.toBeNull();
    expect(s.recall!.p50).toBe(80);
    expect(s.recall!.calls).toBe(3);
  });

  it("records cron depth", () => {
    recordCronDepth(2);
    recordCronDepth(5);
    recordCronDepth(3);
    const s = getMetricsSummary();
    expect(s.cronDepth.max).toBe(5);
    expect(s.cronDepth.avg).toBeCloseTo(3.33, 0);
  });

  it("flushToFile appends JSONL", () => {
    recordLatency("llm:test", 100);
    recordCall("llm:test", true);
    flushToFile();
    flushToFile();
    const path = join(tmp, "metrics", "metrics.jsonl");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.ts).toBeGreaterThan(0);
    expect(parsed.llm.test).toBeDefined();
  });

  it("recordCompaction aggregates real passes, persists all events (incl skipped) to JSONL (#1022)", () => {
    const ev = (over: Partial<CompactionEvent>): CompactionEvent => ({
      conversationId: "1_A_01", timestamp: Date.now(), tokensBefore: 1000, tokensAfter: 200,
      savingsPct: 0.8, model: "cheap", durationMs: 100, level: "normal", ...over,
    });
    recordCompaction(ev({ level: "normal", savingsPct: 0.8 }));
    recordCompaction(ev({ level: "fallback", savingsPct: 0 }));
    recordCompaction(ev({ level: "skipped", savingsPct: 0, durationMs: 0 })); // audit-only

    const s = getMetricsSummary();
    expect(s.compaction).not.toBeNull();
    expect(s.compaction!.count).toBe(2);        // skipped excluded from aggregate
    expect(s.compaction!.failures).toBe(0);
    expect(s.compaction!.avgSavingsPct).toBe(40); // (0.8 + 0) / 2

    const path = join(tmp, "metrics", "metrics.jsonl");
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);               // all three persisted, including skipped
    expect(JSON.parse(lines[0]!).type).toBe("compaction");
  });
});
