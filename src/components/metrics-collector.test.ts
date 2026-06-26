import { describe, it, expect, beforeEach } from "vitest";
import { recordLatency, recordCall, recordCronDepth, getMetricsSummary, initMetrics, flushToFile, pruneMetricsFile } from "./metrics-collector.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("pruneMetricsFile removes old lines", () => {
    recordLatency("llm:x", 50);
    flushToFile();
    // Manually write an old line
    const path = join(tmp, "metrics", "metrics.jsonl");
    const old = JSON.stringify({ ts: Date.now() - 8 * 24 * 60 * 60 * 1000, llm: {} }) + "\n";
    const current = readFileSync(path, "utf-8");
    const { writeFileSync } = require("node:fs");
    writeFileSync(path, old + current);
    // Should have 2 lines now
    expect(readFileSync(path, "utf-8").trim().split("\n").length).toBe(2);
    pruneMetricsFile();
    // Old line removed
    expect(readFileSync(path, "utf-8").trim().split("\n").length).toBe(1);
  });
});
