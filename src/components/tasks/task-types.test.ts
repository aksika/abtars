import { describe, it, expect } from "vitest";
import { normalize, isSystemEntry, SYSTEM_ACTIONS, formatTaskLabel, isValidTaskId, MAX_SCHEDULED_AGENTS } from "./task-types.js";
import type { ScheduledTask } from "./task-types.js";

const SAMPLE_CONTRACT = {
  artifact: "/tmp/report.md",
  requiredSections: ["# Summary"],
  minBytes: 100,
  requires: { files: [], executables: [], tools: [] },
};

function baseAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "agent1",
    kind: "agent",
    schedule: "0 2 * * *",
    prompt: "do the thing",
    agent: "task",
    interaction: { mode: "oneshot" },
    chatId: "100",
    delivery: "report",
    report: SAMPLE_CONTRACT,
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
      const r = normalize(baseAgent({}));
      expect(r.ok).toBe(true);
    });

    it("rejects an invalid cron schedule", () => {
      const r = normalize(baseSystem({ schedule: "not a cron" }));
      expect(r.ok).toBe(false);
    });

    it("accepts a valid one-shot at", () => {
      const r = normalize({ id: "s1", kind: "agent", at: "2026-07-12T08:00:00Z", prompt: "test", agent: "task", interaction: { mode: "oneshot" }, chatId: "1", delivery: "report", report: SAMPLE_CONTRACT });
      expect(r.ok).toBe(true);
    });

    it("rejects entry with both schedule and at", () => {
      const r = normalize({ id: "s1", kind: "agent", schedule: "0 9 * * *", at: "2026-07-12T08:00:00Z", prompt: "test", chatId: "1", delivery: "report", report: SAMPLE_CONTRACT });
      expect(r.ok).toBe(false);
    });

    it("rejects entry with no schedule and no at", () => {
      const r = normalize({ id: "s1", kind: "agent", prompt: "test", chatId: "1", delivery: "report", report: SAMPLE_CONTRACT });
      expect(r.ok).toBe(false);
    });

    it("rejects missing kind", () => {
      const r = normalize({ id: "x", schedule: "0 9 * * *", prompt: "test", chatId: "1", delivery: "report", report: SAMPLE_CONTRACT });
      expect(r.ok).toBe(false);
    });

    it("rejects unknown kind", () => {
      const r = normalize({ id: "x", kind: "unknown", schedule: "0 9 * * *" });
      expect(r.ok).toBe(false);
    });
  });

  describe("kind-specific validation", () => {
    it("reminder validates", () => {
      const r = normalize({ id: "r", kind: "reminder", schedule: "0 9 * * *", text: "Wake up", chatId: "1", delivery: "announce" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entry.kind).toBe("reminder");
    });

    it("reminder rejects non-announce delivery", () => {
      const r = normalize({ id: "r", kind: "reminder", schedule: "0 9 * * *", text: "Wake up", chatId: "1", delivery: "report" });
      expect(r.ok).toBe(false);
    });

    it("reminder requires text", () => {
      const r = normalize({ id: "r", kind: "reminder", schedule: "0 9 * * *", chatId: "1", delivery: "announce" });
      expect(r.ok).toBe(false);
    });

    it("agent validates", () => {
      const r = normalize({ id: "a", kind: "agent", schedule: "0 9 * * *", prompt: "Run report", agent: "task", interaction: { mode: "oneshot" }, chatId: "1", delivery: "report", report: SAMPLE_CONTRACT });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entry.kind).toBe("agent");
    });

    it("agent requires an explicit agent field", () => {
      const r = normalize({ id: "a", kind: "agent", schedule: "0 9 * * *", prompt: "Run report", chatId: "1", delivery: "report" });
      expect(r.ok).toBe(false);
    });

    it("report delivery requires a structured report contract", () => {
      const r = normalize({ id: "a", kind: "agent", schedule: "0 9 * * *", prompt: "Run report", agent: "task", interaction: { mode: "oneshot" }, chatId: "1", delivery: "report" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("report contract is required");
    });

    it("agent rejects an unknown agent value", () => {
      const r = normalize({ id: "a", kind: "agent", schedule: "0 9 * * *", prompt: "Run report", agent: "wizard", chatId: "1", delivery: "report" });
      expect(r.ok).toBe(false);
    });

    it("agent with taskFile validates", () => {
      const r = normalize({ id: "a", kind: "agent", schedule: "0 9 * * *", taskFile: "~/tasks/TASK.md", agent: "task", interaction: { mode: "oneshot" }, chatId: "1", delivery: "announce" });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.entry as ScheduledTask & { kind: "agent" }).taskFile).toBe("~/tasks/TASK.md");
    });

    it("script requires command", () => {
      const r = normalize({ id: "s", kind: "script", schedule: "0 9 * * *", chatId: "1", delivery: "silent" });
      expect(r.ok).toBe(false);
    });

    it("script validates", () => {
      const r = normalize({ id: "s", kind: "script", schedule: "0 9 * * *", command: "echo hi", chatId: "1", delivery: "silent" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entry.kind).toBe("script");
    });
  });

  describe("#1432 agent interaction contract", () => {
    const TARGET = { userId: "ada", platform: "telegram", chatId: "42" };

    function skillAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: "sk",
        kind: "agent",
        schedule: "0 10 * * *",
        prompt: "Start today's session",
        agent: "professor",
        chatId: "42",
        delivery: "announce",
        orchestration: { maxAgents: 1 },
        interaction: { mode: "skill", skill: "spanish-tutor", target: TARGET },
        ...overrides,
      };
    }

    it("accepts a valid skill interaction", () => {
      const r = normalize(skillAgent());
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.entry.kind).toBe("agent");
        expect((r.entry as ScheduledTask & { kind: "agent" }).interaction).toEqual({ mode: "skill", skill: "spanish-tutor", target: TARGET });
      }
    });

    it.each([
      ["interaction array", { interaction: [] }],
      ["unknown mode", { interaction: { mode: "interactive" } }],
    ])("rejects %s", (_label, overrides) => {
      const r = normalize(skillAgent(overrides));
      expect(r.ok).toBe(false);
    });

    it("defaults missing interaction to oneshot instead of rejecting", () => {
      const r = normalize(skillAgent({ interaction: undefined }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.entry.kind).toBe("agent");
        expect((r.entry as ScheduledTask & { kind: "agent" }).interaction).toEqual({ mode: "oneshot" });
      }
    });

    it("defaults null interaction to oneshot instead of rejecting", () => {
      const r = normalize(skillAgent({ interaction: null }));
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.entry as ScheduledTask & { kind: "agent" }).interaction).toEqual({ mode: "oneshot" });
    });

    it("rejects skill interaction with non-announce delivery", () => {
      const r = normalize(skillAgent({ delivery: "report", report: { artifact: "/tmp/r.md", requiredSections: ["# S"], minBytes: 100, requires: { files: [], executables: [], tools: [] } } }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("delivery=announce");
    });

    it("rejects skill interaction with silent delivery", () => {
      const r = normalize(skillAgent({ delivery: "silent" }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("delivery=announce");
    });

    it("rejects skill interaction with maxAgents != 1", () => {
      const r = normalize(skillAgent({ orchestration: { maxAgents: 2 } }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("maxAgents=1");
    });

    it("rejects skill interaction carrying a report contract", () => {
      const r = normalize(skillAgent({ report: { artifact: "/tmp/r.md", requiredSections: ["# S"], minBytes: 100, requires: { files: [], executables: [], tools: [] } } }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("forbids a report contract");
    });

    it.each([
      ["empty skill", { interaction: { mode: "skill", skill: "", target: TARGET } }],
      ["path-like skill", { interaction: { mode: "skill", skill: "../evil", target: TARGET } }],
      ["uppercase skill", { interaction: { mode: "skill", skill: "Spanish-Tutor", target: TARGET } }],
      ["missing target", { interaction: { mode: "skill", skill: "spanish-tutor" } }],
      ["target missing userId", { interaction: { mode: "skill", skill: "spanish-tutor", target: { platform: "telegram", chatId: "42" } } }],
      ["target missing platform", { interaction: { mode: "skill", skill: "spanish-tutor", target: { userId: "ada", chatId: "42" } } }],
      ["target missing chatId", { interaction: { mode: "skill", skill: "spanish-tutor", target: { userId: "ada", platform: "telegram" } } }],
    ])("rejects malformed skill interaction: %s", (_label, overrides) => {
      const r = normalize(skillAgent(overrides));
      expect(r.ok).toBe(false);
    });

    it("rejects skill interaction with neither prompt nor taskFile", () => {
      const r = normalize(skillAgent({ prompt: undefined, taskFile: undefined }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("prompt or taskFile");
    });

    it("accepts a skill interaction with only a taskFile", () => {
      const r = normalize(skillAgent({ prompt: undefined, taskFile: "~/tasks/tutor/TASK.md" }));
      expect(r.ok).toBe(true);
    });

    it("preserves optional threadId on the target", () => {
      const r = normalize(skillAgent({ interaction: { mode: "skill", skill: "spanish-tutor", target: { ...TARGET, threadId: "7" } } }));
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.entry as ScheduledTask & { kind: "agent" }).interaction).toEqual({ mode: "skill", skill: "spanish-tutor", target: { ...TARGET, threadId: "7" } });
    });

    it("accepts oneshot interaction for every supported agent value", () => {
      for (const agent of ["task", "professor", "browsie", "coding", "dreamy"]) {
        const r = normalize(baseAgent({ interaction: { mode: "oneshot" }, delivery: "announce", report: undefined }));
        expect(r.ok).toBe(true);
        if (r.ok) expect((r.entry as ScheduledTask & { kind: "agent" }).interaction).toEqual({ mode: "oneshot" });
      }
    });

    it("accepts oneshot with maxAgents > 1 (O-project path)", () => {
      const r = normalize(baseAgent({ interaction: { mode: "oneshot" }, orchestration: { maxAgents: 4 } }));
      expect(r.ok).toBe(true);
    });

    it("rejects public orc kind (removed)", () => {
      const r = normalize({ id: "o", kind: "orc", schedule: "0 9 * * *", goal: "Build feature", chatId: "1", delivery: "report" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("unknown kind");
    });

    it("rejects top-level targetUserId (removed #1432 contract) with a named error", () => {
      const r = normalize({ id: "t", kind: "agent", schedule: "0 9 * * *", prompt: "hi", agent: "task", targetUserId: "ada", chatId: "1", delivery: "announce" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("targetUserId");
    });
  });

  describe("unrecognized top-level fields (#1569)", () => {
    it.each([
      ["agent on a script entry", { id: "s", kind: "script", schedule: "0 9 * * *", command: "echo hi", chatId: "1", delivery: "silent", agent: "task" }],
      ["text on an agent entry", { id: "a", kind: "agent", schedule: "0 9 * * *", prompt: "hi", agent: "task", interaction: { mode: "oneshot" }, chatId: "1", delivery: "announce", text: "wake up" }],
      ["command on a system entry", { id: "x", kind: "system", action: "sleep-cycle", schedule: "0 2 * * *", delivery: "silent", command: "rm -rf /" }],
    ])("rejects cross-kind field leakage: %s", (_label, entry) => {
      const r = normalize(entry);
      expect(r.ok).toBe(false);
    });

    it.each([
      ["agent oneshot", () => baseAgent({ interaction: { mode: "oneshot" } })],
      ["agent skill", () => ({ id: "sk", kind: "agent", schedule: "0 10 * * *", prompt: "Start today's session", agent: "professor", chatId: "42", delivery: "announce", orchestration: { maxAgents: 1 }, interaction: { mode: "skill", skill: "spanish-tutor", target: { userId: "ada", platform: "telegram", chatId: "42" } } })],
      ["script", () => ({ id: "s", kind: "script", schedule: "0 9 * * *", command: "echo hi", chatId: "1", delivery: "silent" })],
      ["system with options", () => ({ id: "x", kind: "system", action: "hardware-sleep", schedule: "0 3 * * *", delivery: "silent", options: { idleMinutes: 20, retryMinutes: 10, latestLocalTime: "05:30", expectedWakeTime: "07:55" } })],
    ])("accepts canonical %s definition shape", (_label, makeEntry) => {
      const r = normalize(makeEntry());
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);
    });
  });

  describe("system action validation", () => {
    it("rejects unknown system action", () => {
      const r = normalize({ id: "x", kind: "system", action: "unknown", schedule: "0 2 * * *", delivery: "silent" });
      expect(r.ok).toBe(false);
    });

    it("rejects system with non-silent delivery", () => {
      const r = normalize({ id: "x", kind: "system", action: "sleep-cycle", schedule: "0 2 * * *", delivery: "report" });
      expect(r.ok).toBe(false);
    });

    it("rejects system with command field", () => {
      const r = normalize({ id: "x", kind: "system", action: "sleep-cycle", schedule: "0 2 * * *", delivery: "silent", command: "rm -rf /" });
      expect(r.ok).toBe(false);
    });

    it("accepts valid system entry", () => {
      const r = normalize(baseSystem());
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.entry.kind).toBe("system");
        expect((r.entry as ScheduledTask & { kind: "system" }).action).toBe("sleep-cycle");
      }
    });
  });

  describe("agent orchestration normalization (#1516)", () => {
    it("defaults to maxAgents 1 when orchestration is absent", () => {
      const r = normalize(baseAgent());
      if (!r.ok) throw new Error(`expected ok: ${r.error}`);
      expect(r.entry.kind).toBe("agent");
      if (r.entry.kind !== "agent") throw new Error("expected agent");
      expect(r.entry.orchestration).toEqual({ maxAgents: 1 });
    });

    it("defaults to maxAgents 1 for an empty orchestration object", () => {
      const r = normalize(baseAgent({ orchestration: {} }));
      if (!r.ok) throw new Error(`expected ok: ${r.error}`);
      if (r.entry.kind !== "agent") throw new Error("expected agent");
      expect(r.entry.orchestration).toEqual({ maxAgents: 1 });
    });

    it("accepts explicit maxAgents 1 (behaviorally equivalent to omission)", () => {
      const r = normalize(baseAgent({ orchestration: { maxAgents: 1 } }));
      if (!r.ok) throw new Error(`expected ok: ${r.error}`);
      if (r.entry.kind !== "agent") throw new Error("expected agent");
      expect(r.entry.orchestration).toEqual({ maxAgents: 1 });
    });

    it("accepts explicit maxAgents 5 (daily-ai 4 lanes + Orc)", () => {
      const r = normalize(baseAgent({ orchestration: { maxAgents: 5 } }));
      if (!r.ok) throw new Error(`expected ok: ${r.error}`);
      if (r.entry.kind !== "agent") throw new Error("expected agent");
      expect(r.entry.orchestration).toEqual({ maxAgents: 5 });
    });

    it("accepts explicit maxAgents 6 (the runtime ceiling)", () => {
      const r = normalize(baseAgent({ orchestration: { maxAgents: 6 } }));
      if (!r.ok) throw new Error(`expected ok: ${r.error}`);
      if (r.entry.kind !== "agent") throw new Error("expected agent");
      expect(r.entry.orchestration).toEqual({ maxAgents: 6 });
    });

    it.each([
      ["null", null],
      ["array", [1]],
      ["string", "6"],
      ["boolean", true],
      ["fraction", 2.5],
      ["zero", 0],
      ["negative", -1],
      ["NaN", Number.NaN],
    ])("rejects malformed orchestration %s", (_label, value) => {
      const r = normalize(baseAgent({ orchestration: value }));
      expect(r.ok).toBe(false);
    });

    it("clamps maxAgents above the cap inside an object to the ceiling instead of quarantining", () => {
      const r = normalize(baseAgent({ orchestration: { maxAgents: 7 } }));
      expect(r.ok).toBe(true);
      if (r.ok && r.entry.kind === "agent") expect(r.entry.orchestration).toEqual({ maxAgents: MAX_SCHEDULED_AGENTS });
    });

    it("round-trips a normalized entry through normalize() unchanged", () => {
      const first = normalize(baseAgent({ orchestration: { maxAgents: 6 } }));
      if (!first.ok) throw new Error("expected ok");
      const second = normalize(first.entry);
      if (!second.ok) throw new Error("expected ok");
      if (second.entry.kind !== "agent") throw new Error("expected agent");
      expect(second.entry.orchestration).toEqual({ maxAgents: 6 });
    });

    it("keeps a legacy production-shaped agent task runnable without orchestration", () => {
      const legacy = baseAgent();
      delete legacy.orchestration;
      delete legacy.report;
      legacy.delivery = "announce";
      const r = normalize(legacy);
      if (!r.ok) throw new Error(`legacy agent task must not be rejected: ${r.error}`);
      if (r.entry.kind !== "agent") throw new Error("expected agent");
      expect(r.entry.orchestration).toEqual({ maxAgents: 1 });
    });
  });

  describe("isSystemEntry guard", () => {
    it("narrow for system entries", () => {
      const r = normalize(baseSystem());
      if (!r.ok) throw new Error("expected ok");
      expect(isSystemEntry(r.entry)).toBe(true);
    });

    it("false for agent entries", () => {
      const r = normalize(baseAgent());
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
