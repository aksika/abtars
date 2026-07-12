import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let ExecutorLeaseStore: typeof import("./executor-lease-store.js").ExecutorLeaseStore;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `lease-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const mod = await import("./executor-lease-store.js");
  ExecutorLeaseStore = mod.ExecutorLeaseStore;
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

const ALIVE_EVENT = {
  schema_version: 1 as const,
  attempt_id: "a_test_001",
  claim_generation: 1,
  executor: { kind: "agent" as const, id: "spin-01" },
  sequence: 1,
  kind: "alive" as const,
  producer_at: "2026-07-13T00:00:00.000Z",
  payload: {},
};

const MILESTONE_EVENT = {
  ...ALIVE_EVENT,
  sequence: 2,
  kind: "durable_milestone" as const,
  payload: { milestone_id: "m1", summary: "Evidence committed" },
};

describe("ExecutorLeaseStore", () => {
  it("creates tables on first use", () => {
    const store = new ExecutorLeaseStore();
    expect(store).toBeInstanceOf(ExecutorLeaseStore);
  });

  it("ingests an alive event and creates snapshot", () => {
    const store = new ExecutorLeaseStore();
    const result = store.ingestEvent(ALIVE_EVENT, new Date().toISOString());
    expect("snapshot" in result).toBe(true);
    if ("snapshot" in result) {
      expect(result.snapshot.highWaterSequence).toBe(1);
      expect(result.snapshot.semanticState).toBe("alive");
    }
  });

  it("rejects duplicate sequence", () => {
    const store = new ExecutorLeaseStore();
    const ts = new Date().toISOString();
    store.ingestEvent(ALIVE_EVENT, ts);
    const result = store.ingestEvent(ALIVE_EVENT, ts);
    expect("conflict" in result).toBe(true);
  });

  it("rejects wrong generation", () => {
    const store = new ExecutorLeaseStore();
    store.ingestEvent(ALIVE_EVENT, new Date().toISOString());
    const wrongGen = { ...ALIVE_EVENT, claim_generation: 2, sequence: 5 };
    const result = store.ingestEvent(wrongGen, new Date().toISOString());
    expect("conflict" in result).toBe(true);
  });

  it("advances high water mark with later events", () => {
    const store = new ExecutorLeaseStore();
    store.ingestEvent(ALIVE_EVENT, new Date().toISOString());
    store.ingestEvent(MILESTONE_EVENT, new Date().toISOString());
    const snapshot = store.getSnapshot("a_test_001");
    expect(snapshot).toBeDefined();
    expect(snapshot!.highWaterSequence).toBe(2);
  });

  it("getSnapshot returns undefined for unknown attempt", () => {
    const store = new ExecutorLeaseStore();
    expect(store.getSnapshot("nonexistent")).toBeUndefined();
  });

  it("stalled event updates semantic state", () => {
    const store = new ExecutorLeaseStore();
    store.ingestEvent(ALIVE_EVENT, new Date().toISOString());
    const stalled = { ...ALIVE_EVENT, sequence: 2, kind: "stalled" as const };
    store.ingestEvent(stalled, new Date().toISOString());
    const snapshot = store.getSnapshot("a_test_001");
    expect(snapshot!.semanticState).toBe("stalled");
  });

  it("updateEvaluation changes evaluation field", () => {
    const store = new ExecutorLeaseStore();
    store.ingestEvent(ALIVE_EVENT, new Date().toISOString());
    store.updateEvaluation("a_test_001", "warning");
    expect(store.getSnapshot("a_test_001")!.evaluation).toBe("warning");
  });
});
