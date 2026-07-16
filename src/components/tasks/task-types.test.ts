import { describe, it, expect } from "vitest";
import { normalize, isSystemEntry, SYSTEM_ACTIONS, formatTaskLabel, isValidTaskId } from "./task-types.js";
import type { ScheduledTask } from "./task-types.js";

const NOW = new Date("2026-07-11T02:00:00Z").getTime();

function baseAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "agent1",
    kind: "agent",
    schedule: "0 2 * * *",
    prompt: "do the thing",
    chatId: "100",
    delivery: "report",
    ...overrides,
  };
}

function baseSystem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sleep-cycle",
    kind: "system",
    action: "sleep-cycle",
    schedule: "0 2 * * *",
    delivery: "silent",
    ...overrides,
  };
}

describe("normalize + validation", () => {
  describe("recurring entry normalization", () => {
    it("derives next from schedule", () => {
      const r = normalize(baseAgent({}), NOW);
      expect(r.ok).toBe(true);
    });

    it("rejects an invalid cron schedule", () => {
      const r = normalize(baseSystem({ schedule: "not a cron" }), NOW);
      expect(r.ok).toBe(false);
    });

    it("accepts a valid one-shot at", () => {
      const r = normalize({ id: "s1", kind: "agent", at: "2026-07-12T08:00:00Z", prompt: "test", chatId: "1", delivery: "report" }, NOW);
      expect(r.ok).toBe(true);
    });

    it("rejects entry with both schedule and at", () => {
      const r = normalize({ id: "s1", kind: "agent", schedule: "0 9 * * *", at: "2026-07-12T08:00:00Z", prompt: "test", chatId: "1", delivery: "report" }, NOW);
      expect(r.ok).toBe(false);
    });

    it("rejects entry with no schedule and no at", () => {
      const r = normalize({ id: "s1", kind: "agent", prompt: "test", chatId: "1", delivery: "report" }, NOW);
      expect(r.ok).toBe(false);
    });

    it("rejects missing kind", () => {
      const r = normalize({ id: "x", schedule: "0 9 * * *", prompt: "test", chatId: "1", delivery: "report" }, NOW);
      expect(r.ok).toBe(false);
    });

    it("rejects unknown kind", () => {
      const r = normalize({ id: "x", kind: "unknown", schedule: "0 9 * * *" }, NOW);
      expect(r.ok).toBe(false);
    });
  });

  describe("kind-specific validation", () => {
    it("reminder validates", () => {
      const r = normalize({ id: "r", kind: "reminder", schedule: "0 9 * * *", text: "Wake up", chatId: "1", delivery: "announce" }, NOW);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entry.kind).toBe("reminder");
    });

    it("reminder rejects non-announce delivery", () => {
      const r = normalize({ id: "r", kind: "reminder", schedule: "0 9 * * *", text: "Wake up", chatId: "1", delivery: "report" }, NOW);
      expect(r.ok).toBe(false);
    });

    it("reminder requires text", () => {
      const r = normalize({ id: "r", kind: "reminder", schedule: "0 9 * * *", chatId: "1", delivery: "announce" }, NOW);
      expect(r.ok).toBe(false);
    });

    it("agent validates", () => {
      const r = normalize({ id: "a", kind: "agent", schedule: "0 9 * * *", prompt: "Run report", chatId: "1", delivery: "report" }, NOW);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entry.kind).toBe("agent");
    });

    it("agent with taskFile validates", () => {
      const r = normalize({ id: "a", kind: "agent", schedule: "0 9 * * *", taskFile: "~/tasks/TASK.md", chatId: "1", delivery: "report" }, NOW);
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.entry as ScheduledTask & { kind: "agent" }).taskFile).toBe("~/tasks/TASK.md");
    });

    it("script requires command", () => {
      const r = normalize({ id: "s", kind: "script", schedule: "0 9 * * *", chatId: "1", delivery: "silent" }, NOW);
      expect(r.ok).toBe(false);
    });

    it("script validates", () => {
      const r = normalize({ id: "s", kind: "script", schedule: "0 9 * * *", command: "echo hi", chatId: "1", delivery: "silent" }, NOW);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entry.kind).toBe("script");
    });

    it("orc requires goal", () => {
      const r = normalize({ id: "o", kind: "orc", schedule: "0 9 * * *", chatId: "1", delivery: "report" }, NOW);
      expect(r.ok).toBe(false);
    });

    it("orc validates", () => {
      const r = normalize({ id: "o", kind: "orc", schedule: "0 9 * * *", goal: "Build feature", chatId: "1", delivery: "report" }, NOW);
      expect(r.ok).toBe(true);
    });
  });

  describe("system action validation", () => {
    it("rejects unknown system action", () => {
      const r = normalize({ id: "x", kind: "system", action: "unknown", schedule: "0 2 * * *", delivery: "silent" }, NOW);
      expect(r.ok).toBe(false);
    });

    it("rejects system with non-silent delivery", () => {
      const r = normalize({ id: "x", kind: "system", action: "sleep-cycle", schedule: "0 2 * * *", delivery: "report" }, NOW);
      expect(r.ok).toBe(false);
    });

    it("rejects system with command field", () => {
      const r = normalize({ id: "x", kind: "system", action: "sleep-cycle", schedule: "0 2 * * *", delivery: "silent", command: "rm -rf /" }, NOW);
      expect(r.ok).toBe(false);
    });

    it("accepts valid system entry", () => {
      const r = normalize(baseSystem(), NOW);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.entry.kind).toBe("system");
        expect((r.entry as ScheduledTask & { kind: "system" }).action).toBe("sleep-cycle");
      }
    });
  });

  describe("isSystemEntry guard", () => {
    it("narrow for system entries", () => {
      const r = normalize(baseSystem(), NOW);
      if (!r.ok) throw new Error("expected ok");
      expect(isSystemEntry(r.entry)).toBe(true);
    });

    it("false for agent entries", () => {
      const r = normalize(baseAgent(), NOW);
      if (!r.ok) throw new Error("expected ok");
      expect(isSystemEntry(r.entry)).toBe(false);
    });
  });

  describe("formatTaskLabel", () => {
    it("formats kebab-case to Title Case", () => {
      expect(formatTaskLabel("daily-briefing")).toBe("Daily Briefing");
    });

    it("handles underscores", () => {
      expect(formatTaskLabel("my_task_name")).toBe("My Task Name");
    });

    it("handles single word", () => {
      expect(formatTaskLabel("reminder")).toBe("Reminder");
    });
  });

  describe("isValidTaskId", () => {
    it("accepts valid kebab-case", () => {
      expect(isValidTaskId("daily-briefing")).toBe(true);
    });

    it("rejects id with uppercase", () => {
      expect(isValidTaskId("Daily-Briefing")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isValidTaskId("")).toBe(false);
    });

    it("rejects id starting with number", () => {
      expect(isValidTaskId("1daily")).toBe(false);
    });
  });
});
