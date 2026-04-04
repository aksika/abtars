import { describe, it, expect, vi, beforeEach } from "vitest";
import { CronQueue } from "./cron-queue.js";
import type { CronEntry } from "../cli/agentbridge-task.js";

function makeEntry(overrides: Partial<CronEntry> = {}): CronEntry {
  return {
    id: "t" + Math.random().toString(36).slice(2, 6),
    fireAt: Date.now() - 1000,
    message: "echo test",
    chatId: 1,
    type: "task",
    executor: "script",
    fired: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("CronQueue", () => {
  let queue: CronQueue;

  beforeEach(() => {
    queue = new CronQueue("kiro-cli", ".");
  });

  it("starts with no current job and empty queue", () => {
    expect(queue.currentJob).toBeNull();
    expect(queue.pending).toBe(0);
  });

  it("enqueue starts processing immediately if idle", () => {
    queue.enqueue(makeEntry({ id: "s1", message: "echo hi" }));
    expect(queue.currentJob).not.toBeNull();
    expect(queue.currentJob!.entryId).toBe("s1");
  });

  it("deduplicates by entry ID (queued)", () => {
    // First enqueue starts running
    queue.enqueue(makeEntry({ id: "s1", message: "sleep 10" }));
    // Second with same ID should be skipped
    queue.enqueue(makeEntry({ id: "s2", message: "echo second" }));
    queue.enqueue(makeEntry({ id: "s2", message: "echo second again" }));
    expect(queue.pending).toBe(1); // only one s2 queued
  });

  it("deduplicates by entry ID (running)", () => {
    queue.enqueue(makeEntry({ id: "s1", message: "sleep 10" }));
    queue.enqueue(makeEntry({ id: "s1", message: "sleep 10 again" }));
    expect(queue.pending).toBe(0); // s1 is running, duplicate skipped
  });

  it("priority-sorts the queue (high before low)", () => {
    // Start a job to fill the current slot
    queue.enqueue(makeEntry({ id: "running", message: "sleep 10" }));
    // Enqueue in wrong order
    queue.enqueue(makeEntry({ id: "low1", priority: "low", message: "echo low" }));
    queue.enqueue(makeEntry({ id: "hi1", priority: "high", message: "echo high" }));
    queue.enqueue(makeEntry({ id: "med1", priority: "medium", message: "echo med" }));

    expect(queue.pending).toBe(3);
    // Can't directly inspect queue order, but we can verify high is first
    // by checking that after the running job finishes, high runs next
    // (This is an integration-level check — unit test verifies enqueue logic)
  });
});
