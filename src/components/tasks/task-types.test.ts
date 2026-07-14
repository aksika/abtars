/**
 * task-types.test.ts — schema, normalization, and validation for #1321.
 *
 * Task JSON is data, not code. An invalid entry must be rejected closed and
 * never fall through to agent execution.
 */
import { describe, it, expect } from "vitest";
import { normalize, isSystemEntry, SYSTEM_ACTIONS } from "./task-types.js";

const NOW = new Date("2026-07-11T02:00:00Z").getTime();

function baseAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "agent1",
    type: "task",
    executor: "agent",
    schedule: "0 2 * * *",
    message: "do the thing",
    chatId: 100,
    ...overrides,
  };
}

function baseSystem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sleep-cycle",
    type: "task",
    executor: "system",
    action: "sleep-cycle",
    schedule: "0 2 * * *",
    deliveryMode: "silent",
    ...overrides,
  };
}

describe("#1321 normalize + validation", () => {
  describe("recurring entry normalization", () => {
    it("derives fireAt from schedule when omitted (template entry)", () => {
      const r = normalize(baseSystem({ fireAt: undefined }), NOW);
      expect(r.ok).toBe(true);
      if (r.ok) expect(Number.isFinite(r.entry.fireAt)).toBe(true);
    });

    it("defaults fired=false when omitted", () => {
      const r = normalize(baseSystem({ fired: undefined }), NOW);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entry.fired).toBe(false);
    });

    it("defaults createdAt=now when omitted", () => {
      const r = normalize(baseSystem({ createdAt: undefined }), NOW);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entry.createdAt).toBe(NOW);
    });

    it("rejects an invalid cron schedule", () => {
      const r = normalize(baseSystem({ schedule: "not a cron" }), NOW);
      expect(r.ok).toBe(false);
    });

    it("rejects an entry missing both fireAt and schedule", () => {
      const r = normalize({ id: "x", type: "task", executor: "system", action: "sleep-cycle" }, NOW);
      expect(r.ok).toBe(false);
    });
  });

  describe("system executor allowlist", () => {
    it("accepts the canonical sleep-cycle entry exactly as seeded", () => {
      const canonical = {
        id: "sleep-cycle",
        type: "task",
        executor: "system",
        action: "sleep-cycle",
        schedule: "0 2 * * *",
        catchUp: 6,
        maxRunsPerDay: 1,
        deliveryMode: "silent",
        paused: false,
      };
      const r = normalize(canonical, NOW);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.entry.executor).toBe("system");
        expect(r.entry.action).toBe("sleep-cycle");
        expect(r.entry.fired).toBe(false);
      }
    });

    it("rejects a system entry with an unknown action", () => {
      const r = normalize(baseSystem({ action: "rm-rf" }), NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("unknown system action");
    });

    it("rejects a system entry missing action", () => {
      const r = normalize(baseSystem({ action: undefined }), NOW);
      expect(r.ok).toBe(false);
    });

    it("rejects a system entry carrying a command-like field", () => {
      const r = normalize(baseSystem({ command: "bash -c 'pwn'" }), NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("must not carry");
    });

    it("rejects a system entry carrying a taskFile", () => {
      const r = normalize(baseSystem({ taskFile: "/etc/passwd" }), NOW);
      expect(r.ok).toBe(false);
    });

    it("rejects a system entry carrying an agent field", () => {
      const r = normalize(baseSystem({ agent: "dreamy" }), NOW);
      expect(r.ok).toBe(false);
    });

    it("system entry does not require message/chatId", () => {
      const r = normalize(baseSystem(), NOW);
      expect(r.ok).toBe(true);
    });

    it("SYSTEM_ACTIONS allowlist contains sleep-cycle and hardware-sleep for #1321/#1322", () => {
      expect(SYSTEM_ACTIONS).toEqual(["sleep-cycle", "hardware-sleep"]);
    });
  });

  describe("non-system entries keep current behavior", () => {
    it("agent entry defaults executor when omitted (back-compat)", () => {
      const r = normalize({ id: "a", type: "task", schedule: "0 9 * * *", message: "hi", chatId: 1 }, NOW);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entry.executor).toBe("agent");
    });

    it("agent entry requires message", () => {
      const r = normalize({ id: "a", type: "task", executor: "agent", schedule: "0 9 * * *", chatId: 1 }, NOW);
      expect(r.ok).toBe(false);
    });

    it("agent entry requires chatId", () => {
      const r = normalize({ id: "a", type: "task", executor: "agent", schedule: "0 9 * * *", message: "hi" }, NOW);
      expect(r.ok).toBe(false);
    });

    it("script entry validates", () => {
      const r = normalize(baseAgent({ executor: "script" }), NOW);
      expect(r.ok).toBe(true);
    });

    it("reminder entry validates", () => {
      const r = normalize({ id: "r", type: "reminder", schedule: "0 9 * * *", message: "wake up", chatId: 1 }, NOW);
      expect(r.ok).toBe(true);
    });

    it("rejects invalid type", () => {
      const r = normalize(baseAgent({ type: "cron" }), NOW);
      expect(r.ok).toBe(false);
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


});
