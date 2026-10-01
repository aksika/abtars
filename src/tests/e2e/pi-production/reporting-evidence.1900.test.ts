/**
 * reporting-evidence.1900.test.ts — #1900 R2/R4 focused regressions.
 *
 * - Blocked-only and cleanup-failure lanes render as JUnit failures and agree
 *   with matrix counts (fail-closed).
 * - Per-lane provider summaries do not overwrite each other.
 * - Stale Orc terminal evidence cannot pass (freshness gate).
 * - A failed scheduled predecessor blocks its restart successor.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultWriter } from "./result-writer.js";
import type { PiAcceptanceMatrixV1 } from "./contracts.js";
import { deriveLaneState, shouldBlockScheduledRestart } from "./runner.js";
import { isScheduledSummary, isFreshOrcEvidence, SCHEDULED_GOAL } from "./scheduled-orc-round-limit.js";
import type { ProviderSummary } from "./contracts.js";

function summary(seq: number, state: string, matched: string[] = []): ProviderSummary {
  return {
    seq,
    candidate: "fixture-model-b",
    action: state,
    aborted: false,
    roleCounts: { user: 1 },
    toolCalls: state === "toolCall" ? ["execute_bash"] : [],
    markerHashes: [],
    markerTexts: [],
    matchedMarkers: matched,
  };
}

describe("#1900 reporting and evidence gates", () => {
  it("treats blocked scenarios as JUnit failures, not passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-1900-report-"));
    try {
      const writer = new ResultWriter({ repoRoot: dir, runId: "run-1900" });
      // ResultWriter validates repoRoot/runId into dir/test-results/... — the
      // temp dir above is the repo root for this test.
      const matrix: PiAcceptanceMatrixV1 = {
        schemaVersion: 1,
        kind: "pi-production-e2e",
        runId: "run-1900",
        startedAt: new Date().toISOString(),
        durationMs: 1000,
        lanes: [{
          lane: "local-unix",
          profile: "full",
          state: "failed",
          scenarios: [{
            name: "scheduled-orc-round-limit-restart",
            lane: "local-unix",
            profile: "full",
            state: "blocked",
            durationMs: 0,
            providerRequestIds: [],
            failure: { stage: "scheduled-orc-round-limit-restart", code: "prereq_missing", message: "blocked: predecessor failed" },
          }],
        }],
      };
      // deriveLaneState agrees: a lane whose only non-pass is blocked is failed.
      expect(deriveLaneState(matrix.lanes[0]!.scenarios)).toBe("failed");
      writer.writeMatrix(matrix);
      writer.writeJunit(matrix);
      const junit = readFileSync(join(dir, "test-results/pi-production-e2e/run-1900/junit.xml"), "utf-8");
      expect(junit).toContain('failures="1"');
      expect(junit).toContain("<failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends cleanup failures without relabeling passes (writer preserves facts)", () => {
    // The runner appends a distinct lane-cleanup case; the writer must count
    // it as a failure while leaving the passed cases intact.
    expect(deriveLaneState([
      { state: "passed" },
      { state: "passed" },
      { state: "failed" },
    ])).toBe("failed");
    expect(deriveLaneState([{ state: "passed" }, { state: "passed" }])).toBe("passed");
    expect(deriveLaneState([{ state: "passed" }, { state: "blocked" }])).toBe("failed");
  });

  it("writes per-lane provider summaries without overwriting", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-1900-provider-"));
    try {
      const writer = new ResultWriter({ repoRoot: dir, runId: "run-1900" });
      writer.writeProviderSummaries([summary(1, "toolCall", [SCHEDULED_GOAL])], "local-unix");
      writer.writeProviderSummaries([summary(2, "text")], "remote-wss");
      const base = join(dir, "test-results/pi-production-e2e/run-1900");
      expect(existsSync(join(base, "local-unix-provider-summaries.json"))).toBe(true);
      expect(existsSync(join(base, "remote-wss-provider-summaries.json"))).toBe(true);
      const local = JSON.parse(readFileSync(join(base, "local-unix-provider-summaries.json"), "utf-8")) as { summaries: ProviderSummary[] };
      const remote = JSON.parse(readFileSync(join(base, "remote-wss-provider-summaries.json"), "utf-8")) as { summaries: ProviderSummary[] };
      expect(local.summaries[0]?.seq).toBe(1);
      expect(remote.summaries[0]?.seq).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognizes scheduled traffic only via bounded registered identities", () => {
    expect(isScheduledSummary(summary(1, "toolCall", [SCHEDULED_GOAL]))).toBe(true);
    expect(isScheduledSummary(summary(2, "toolCall", []))).toBe(false);
    // Preview texts alone (even containing the goal) do not satisfy the
    // predicate — recognition requires the full-text registry match.
    expect(isScheduledSummary({
      ...summary(3, "toolCall", []),
      markerTexts: [`prefix ${SCHEDULED_GOAL}`],
    })).toBe(false);
  });

  it("rejects stale Orc terminal evidence", () => {
    const now = Date.now();
    // Fresh: released now, observation started a minute ago.
    expect(isFreshOrcEvidence({
      workerCardCount: 0,
      providerRoundLimit: true,
      orcRoundLimit: true,
      orcReleasedAt: new Date(now).toISOString(),
    }, now - 60_000)).toBe(true);
    // Stale: released an hour ago, observation started now — reuse forbidden.
    expect(isFreshOrcEvidence({
      workerCardCount: 0,
      providerRoundLimit: true,
      orcRoundLimit: true,
      orcReleasedAt: new Date(now - 3_600_000).toISOString(),
    }, now)).toBe(false);
    // Missing release never counts as fresh.
    expect(isFreshOrcEvidence({
      workerCardCount: 0,
      providerRoundLimit: true,
      orcRoundLimit: true,
    }, now)).toBe(false);
  });

  it("blocks the restart successor when its predecessor did not pass", () => {
    expect(shouldBlockScheduledRestart("scheduled-orc-round-limit-restart", [
      { name: "scheduled-orc-round-limit", state: "failed" },
    ])).toBe(true);
    expect(shouldBlockScheduledRestart("scheduled-orc-round-limit-restart", [
      { name: "scheduled-orc-round-limit", state: "blocked" },
    ])).toBe(true);
    expect(shouldBlockScheduledRestart("scheduled-orc-round-limit-restart", [
      { name: "scheduled-orc-round-limit", state: "passed" },
    ])).toBe(false);
    expect(shouldBlockScheduledRestart("candidate-fallback", [
      { name: "scheduled-orc-round-limit", state: "failed" },
    ])).toBe(false);
  });
});

afterEach(() => {
  // no shared provider in this file
});
