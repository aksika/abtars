import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ScheduledTask } from "./task-types.js";

let home: string;
let taskStore: typeof import("./task-store.js");
let stateStore: typeof import("./task-state-store.js");

const VALID: ScheduledTask = {
  id: "valid-task",
  kind: "agent",
  prompt: "hello",
  agent: "task",
  interaction: { mode: "oneshot" },
  orchestration: { maxAgents: 1 },
  schedule: "* * * * *",
  enabled: true,
  priority: "medium",
  delivery: "silent",
};

const VALID2: ScheduledTask = {
  id: "second-task",
  kind: "agent",
  prompt: "second",
  agent: "task",
  interaction: { mode: "oneshot" },
  orchestration: { maxAgents: 1 },
  schedule: "* * * * *",
  enabled: true,
  priority: "medium",
  delivery: "silent",
};

beforeEach(async () => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "task-store-test-"));
  mkdirSync(join(home, "tasks"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
  taskStore = await import("./task-store.js");
  stateStore = await import("./task-state-store.js");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("task-store catalog inspection", () => {
  it("missing catalog returns complete with zero entries and does not delete existing state rows", () => {
    // seed a live run
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([VALID], null, 2));
    const entries = taskStore.readEntries();
    stateStore.initializeState(entries);
    const now = Date.now();
    stateStore.reserveRun(VALID.id, { runId: "run-1", groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 600_000 });
    expect(stateStore.readState(VALID.id)?.activeRun).toBeDefined();

    // now remove catalog file -> missing
    rmSync(join(home, "tasks", "tasks.json"));
    const catalog = taskStore.readTaskCatalog();
    expect(catalog.kind).toBe("complete");
    if (catalog.kind === "complete") expect(catalog.entries).toHaveLength(0);

    // readEntries on missing should return [] but not delete rows
    expect(taskStore.readEntries()).toEqual([]);
    expect(taskStore.readEntry(VALID.id)).toBeNull();
    expect(stateStore.readState(VALID.id)?.activeRun?.runId).toBe("run-1");
  });

  it("malformed catalog returns unavailable and leaves state and file intact", () => {
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([VALID], null, 2));
    const entries = taskStore.readEntries();
    stateStore.initializeState(entries);
    stateStore.reserveRun(VALID.id, { runId: "run-1", groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), deadlineAt: Date.now() + 600_000 });
    writeFileSync(join(home, "tasks", "tasks.json"), "INVALID JSON {{{");
    const before = readFileSync(join(home, "tasks", "tasks.json"), "utf-8");
    const catalog = taskStore.readTaskCatalog();
    expect(catalog.kind).toBe("unavailable");
    if (catalog.kind === "unavailable") expect(catalog.reason).toBe("invalid_json");
    expect(taskStore.readEntries()).toEqual([]);
    expect(taskStore.readEntry(VALID.id)).toBeNull();
    // no state deletion
    expect(stateStore.readState(VALID.id)?.activeRun?.runId).toBe("run-1");
    // file unchanged
    expect(readFileSync(join(home, "tasks", "tasks.json"), "utf-8")).toBe(before);
    // writeEntry and removeEntry must throw and not rewrite
    expect(() => taskStore.writeEntry(VALID)).toThrow();
    expect(readFileSync(join(home, "tasks", "tasks.json"), "utf-8")).toBe(before);
    expect(() => taskStore.removeEntry(VALID.id)).toThrow();
    expect(readFileSync(join(home, "tasks", "tasks.json"), "utf-8")).toBe(before);
  });

  it("non-array catalog returns unavailable", () => {
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify({ id: "not-array" }, null, 2));
    const catalog = taskStore.readTaskCatalog();
    expect(catalog.kind).toBe("unavailable");
    if (catalog.kind === "unavailable") expect(catalog.reason).toBe("wrong_shape");
  });

  it("partial catalog exposes valid entries and retains rejected raw entries after setEnabled and writeEntry", async () => {
    const invalid = { id: "bad-task", kind: "agent", prompt: "x", agent: "task", interaction: { mode: "oneshot" }, orchestration: { maxAgents: 1 }, schedule: "INVALID CRON", enabled: true, priority: "medium", delivery: "silent" };
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([VALID, invalid, VALID2], null, 2));
    const catalog = taskStore.readTaskCatalog();
    expect(catalog.kind).toBe("partial");
    if (catalog.kind === "partial") {
      expect(catalog.entries.map(e => e.id).sort()).toEqual(["second-task", "valid-task"]);
      expect(catalog.issues).toHaveLength(1);
      expect(catalog.issues[0]!.id).toBe("bad-task");
    }
    // valid entries returned
    expect(taskStore.readEntries().map(e => e.id).sort()).toEqual(["second-task", "valid-task"]);
    // setEnabled must preserve raw quarantined entry
    const service = await import("./task-service.js");
    const beforeRaw = JSON.parse(readFileSync(join(home, "tasks", "tasks.json"), "utf-8")) as unknown[];
    expect(beforeRaw).toHaveLength(3);
    service.setEnabled(VALID.id, false);
    const afterRaw = JSON.parse(readFileSync(join(home, "tasks", "tasks.json"), "utf-8")) as unknown[];
    expect(afterRaw).toHaveLength(3);
    // invalid entry still present as raw
    expect((afterRaw[1] as { id: string }).id).toBe("bad-task");
    // valid entry's enabled changed
    const updated = afterRaw.find(x => (x as { id: string }).id === VALID.id) as { enabled: boolean } | undefined;
    expect(updated?.enabled).toBe(false);

    // writeEntry targeted update preserves quarantined entry
    const updatedValid2: ScheduledTask = { ...VALID2, enabled: false };
    taskStore.writeEntry(updatedValid2);
    const afterWrite = JSON.parse(readFileSync(join(home, "tasks", "tasks.json"), "utf-8")) as unknown[];
    expect(afterWrite).toHaveLength(3);
    expect((afterWrite[1] as { id: string }).id).toBe("bad-task");
  });

  it("readEntries and readEntry leave live rows intact when catalog is quarantined or unavailable", () => {
    // seed two live tasks
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([VALID, VALID2], null, 2));
    let entries = taskStore.readEntries();
    stateStore.initializeState(entries);
    const now = Date.now();
    stateStore.reserveRun(VALID.id, { runId: "run-valid", groupId: "g1", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 600_000 });
    stateStore.reserveRun(VALID2.id, { runId: "run-second", groupId: "g2", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 600_000 });

    // quarantine only VALID (make it invalid)
    const invalidValid = { ...VALID, schedule: "BAD" };
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([invalidValid, VALID2], null, 2));

    // both read paths should not delete either row
    expect(taskStore.readEntries().map(e => e.id)).toEqual([VALID2.id]);
    expect(stateStore.readState(VALID.id)?.activeRun?.runId).toBe("run-valid");
    expect(stateStore.readState(VALID2.id)?.activeRun?.runId).toBe("run-second");

    expect(taskStore.readEntry(VALID.id)).toBeNull();
    expect(stateStore.readState(VALID.id)?.activeRun?.runId).toBe("run-valid");

    expect(taskStore.readEntry(VALID2.id)?.id).toBe(VALID2.id);
    expect(stateStore.readState(VALID2.id)?.activeRun?.runId).toBe("run-second");

    // now make catalog unavailable
    writeFileSync(join(home, "tasks", "tasks.json"), "BAD JSON");
    expect(taskStore.readEntries()).toEqual([]);
    expect(stateStore.readState(VALID.id)?.activeRun?.runId).toBe("run-valid");
    expect(stateStore.readState(VALID2.id)?.activeRun?.runId).toBe("run-second");
  });

  it("initializeState is additive and does not delete orphans", () => {
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([VALID], null, 2));
    let entries = taskStore.readEntries();
    stateStore.initializeState(entries);
    const now = Date.now();
    stateStore.reserveRun(VALID.id, { runId: "run-1", groupId: "g", attempt: 1, trigger: "schedule", occurrenceAt: now, deadlineAt: now + 600_000 });
    // Add second task later
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([VALID, VALID2], null, 2));
    entries = taskStore.readEntries();
    stateStore.initializeState(entries);
    expect(stateStore.readState(VALID.id)?.activeRun?.runId).toBe("run-1");
    expect(stateStore.readState(VALID2.id)).not.toBeNull();

    // Remove VALID from catalog outside CLI — orphan rows must persist
    writeFileSync(join(home, "tasks", "tasks.json"), JSON.stringify([VALID2], null, 2));
    const remaining = taskStore.readEntries();
    expect(remaining.map(e => e.id)).toEqual([VALID2.id]);
    // orphan not deleted
    expect(stateStore.readState(VALID.id)?.activeRun?.runId).toBe("run-1");
  });
});
