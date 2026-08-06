import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;
let mod: typeof import("./task-remediation.js");
let taskStore: typeof import("./task-store.js");

const AGENT_TASK = {
  id: "daily-ai",
  kind: "agent",
  prompt: "produce the daily briefing",
  agent: "task",
  interaction: { mode: "oneshot" },
  orchestration: { maxAgents: 2 },
  maxToolRounds: 8,
  schedule: "0 9 * * *",
  enabled: true,
  priority: "medium",
  delivery: "silent",
  chatId: "1",
};

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `task-remediation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(TEST_HOME, "tasks"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  taskStore = await import("./task-store.js");
  mod = await import("./task-remediation.js");
  taskStore.writeEntry(AGENT_TASK as never);
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function readTask(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(TEST_HOME, "tasks", "tasks.json"), "utf-8")) as Array<Record<string, unknown>>;
  return raw.find((e) => e["id"] === "daily-ai")!;
}

function auditRows(): Array<Record<string, unknown>> {
  const p = mod.REMEDIATION_AUDIT_PATH();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("task remediation (#1588)", () => {
  it("refuses a non-whitelisted field (schedule, orchestration.maxAgents, enabled)", () => {
    const r1 = mod.remediateAdjust("daily-ai", "schedule", 1);
    expect(r1.ok).toBe(false);
    const r2 = mod.remediateAdjust("daily-ai", "orchestration.maxAgents", 2);
    expect(r2.ok).toBe(false);
    const r3 = mod.remediateAdjust("daily-ai", "enabled", 1);
    expect(r3.ok).toBe(false);
    expect(mod.FORBIDDEN_FIELDS).toContain("schedule");
    expect(mod.FORBIDDEN_FIELDS).toContain("orchestration.maxAgents");
    expect(auditRows().every((r) => r["accepted"] === false)).toBe(true);
  });

  it("refuses an over-ceiling value", () => {
    const r = mod.remediateAdjust("daily-ai", "maxToolRounds", mod.REMEDIATION_CEILINGS["maxToolRounds"]! + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ceiling");
    expect(readTask()["maxToolRounds"]).toBe(8);
  });

  it("accepts an increase up to the ceiling itself", () => {
    const ceiling = mod.REMEDIATION_CEILINGS["maxToolRounds"]!;
    const r = mod.remediateAdjust("daily-ai", "maxToolRounds", ceiling);
    expect(r.ok).toBe(true);
    expect(readTask()["maxToolRounds"]).toBe(ceiling);
  });

  it("refuses a budget decrease", () => {
    const r = mod.remediateAdjust("daily-ai", "maxToolRounds", 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("increase-only");
    expect(readTask()["maxToolRounds"]).toBe(8);
  });

  it("accepts an increase within the ceiling and writes exactly one audit row with before/after", () => {
    const r = mod.remediateAdjust("daily-ai", "maxToolRounds", 16);
    expect(r.ok).toBe(true);
    expect(readTask()["maxToolRounds"]).toBe(16);
    const rows = auditRows().filter((row) => row["accepted"] === true && row["field"] === "maxToolRounds");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      taskId: "daily-ai",
      field: "maxToolRounds",
      from: 8,
      to: 16,
      actor: "sha",
    }));
  });

  it("adjusts report.minBytes within its ceiling", () => {
    taskStore.writeEntry({ ...AGENT_TASK, delivery: "report", report: { artifact: "/tmp/r.md", requiredSections: ["## X"], minBytes: 100, requires: { files: [], executables: [], tools: [] } } } as never);
    const r = mod.remediateAdjust("daily-ai", "report.minBytes", 2000);
    expect(r.ok).toBe(true);
    expect((readTask()["report"] as Record<string, unknown>)["minBytes"]).toBe(2000);
    const over = mod.remediateAdjust("daily-ai", "report.minBytes", 5000);
    expect(over.ok).toBe(false);
  });

  it("adjusts orchestration.laneDurationMs and preserves maxAgents", () => {
    const r = mod.remediateAdjust("daily-ai", "orchestration.laneDurationMs", 600000);
    expect(r.ok).toBe(true);
    const orchestration = readTask()["orchestration"] as Record<string, unknown>;
    expect(orchestration["laneDurationMs"]).toBe(600000);
    expect(orchestration["maxAgents"]).toBe(2);
    const decrease = mod.remediateAdjust("daily-ai", "orchestration.laneDurationMs", 300000);
    expect(decrease.ok).toBe(false);
  });

  it("escalate mutates nothing and leaves tasks.json byte-identical", () => {
    const before = readFileSync(join(TEST_HOME, "tasks", "tasks.json"), "utf-8");
    const r = mod.remediateEscalate("daily-ai", "daily-ai lane 3 needs a fresh auth cookie for example.com; provide it and I will retry", "lane_late_completion");
    expect(r.ok).toBe(true);
    const after = readFileSync(join(TEST_HOME, "tasks", "tasks.json"), "utf-8");
    expect(after).toBe(before);
    const ask = auditRows().filter((row) => row["field"] === "escalate");
    expect(ask).toHaveLength(1);
    expect(String(ask[0]!["reason"])).toContain("fresh auth cookie");
    expect(ask[0]!["diagnosticCode"]).toBe("lane_late_completion");
  });

  it("refuses adjust for a missing task", () => {
    const r = mod.remediateAdjust("nope", "maxToolRounds", 16);
    expect(r.ok).toBe(false);
  });

  it("refuses budget fields for non-agent tasks", () => {
    taskStore.writeEntry({ id: "gate-script", kind: "script", command: "echo hi", schedule: "* * * * *", enabled: true, priority: "medium", delivery: "silent" } as never);
    const r = mod.remediateAdjust("gate-script", "maxToolRounds", 16);
    expect(r.ok).toBe(false);
  });
});
