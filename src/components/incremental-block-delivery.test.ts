/**
 * #1619 — incremental-block-delivery controller: bounded master-chat progress
 * blocks (thinking coalescing), pre-tool semantic segment reconciliation, and
 * exact eligibility. Uses fake timers and a recording adapter; never mocks
 * controller internals.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  IncrementalBlockDeliveryController,
  isIncrementalEligible,
  THINKING_BLOCK_PREFIX,
} from "./incremental-block-delivery.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeHarness(opts?: {
  flushIntervalMs?: number;
  maxBlockBytes?: number;
  sendBlock?: (text: string) => Promise<unknown>;
  chunkBound?: (text: string) => string[];
}) {
  const sent: string[] = [];
  const failed: string[] = [];
  const controller = new IncrementalBlockDeliveryController({
    sendBlock: opts?.sendBlock
      ? opts.sendBlock
      : async (text) => { sent.push(text); },
    sanitize: (t: string) => t.trim(),
    chunkBound: opts?.chunkBound ?? ((t: string) => [t]),
    flushIntervalMs: opts?.flushIntervalMs ?? 4000,
    maxBlockBytes: opts?.maxBlockBytes ?? 4000,
    logContentFree: (detail: string) => failed.push(detail),
  });
  return { controller, sent, failed };
}

describe("IncrementalBlockDeliveryController", () => {
  it("buffers thinking and flushes it on the bounded interval as a marked block", async () => {
    vi.useFakeTimers();
    const { controller, sent } = makeHarness();
    controller.accept({ kind: "thinking", text: "let me think" });
    expect(sent.length).toBe(0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent).toEqual([`${THINKING_BLOCK_PREFIX}let me think`]);
    controller.dispose();
  });

  it("flushes at the UTF-8 content cap even before the interval", async () => {
    vi.useFakeTimers();
    const { controller, sent } = makeHarness({ maxBlockBytes: 100 });
    controller.accept({ kind: "thinking", text: "a".repeat(50) });
    controller.accept({ kind: "thinking", text: "b".repeat(60) });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("a".repeat(50));
    controller.dispose();
  });

  it("flushes pending thinking on a thinking→text transition", async () => {
    vi.useFakeTimers();
    const { controller, sent } = makeHarness();
    controller.accept({ kind: "thinking", text: "pondering" });
    controller.accept({ kind: "text", text: "answer" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("pondering");
    controller.dispose();
  });

  it("never delivers text deltas incrementally — only thinking becomes blocks", async () => {
    vi.useFakeTimers();
    const { controller, sent } = makeHarness();
    controller.accept({ kind: "text", text: "visible answer" });
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent.length).toBe(0);
    controller.dispose();
  });

  it("drops empty/control-only output and flushes per chunk when chunked", async () => {
    vi.useFakeTimers();
    const { controller, sent } = makeHarness({
      chunkBound: (t: string) => (t.length > 10 ? [t.slice(0, 10), t.slice(10)] : [t]),
    });
    controller.accept({ kind: "thinking", text: "" });
    controller.accept({ kind: "thinking", text: "  \n\t  " });
    controller.accept({ kind: "thinking", text: "1234567890123" });
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent).toEqual([
      `${THINKING_BLOCK_PREFIX}1234567890`,
      `${THINKING_BLOCK_PREFIX}123`,
    ]);
    controller.dispose();
  });

  it("logs a content-free failure when a progress block send throws", async () => {
    vi.useFakeTimers();
    const { controller, failed } = makeHarness({
      sendBlock: async () => { throw new Error("platform down"); },
    });
    controller.accept({ kind: "thinking", text: "secret reasoning" });
    await vi.advanceTimersByTimeAsync(4000);
    expect(failed.length).toBe(1);
    expect(failed[0]).not.toContain("secret");
    expect(failed[0]).toContain("content-free");
    controller.dispose();
  });

  it("records successful segments and strips them from a matching terminal prefix", () => {
    vi.useFakeTimers();
    const { controller } = makeHarness();
    controller.segmentDelivered("Let me search for that.");
    const reconciled = controller.reconcileTerminal("Let me search for that.\n\n[Search results]");
    expect(reconciled).toBe("[Search results]");
    controller.dispose();
  });

  it("strips a fully-duplicated terminal (segment was the whole answer)", () => {
    vi.useFakeTimers();
    const { controller } = makeHarness();
    controller.segmentDelivered("Done.");
    expect(controller.reconcileTerminal("Done.")).toBe("");
    controller.dispose();
  });

  it("never heuristically deletes unrelated repeated prose", () => {
    vi.useFakeTimers();
    const { controller } = makeHarness();
    controller.segmentDelivered("Let me search for that.");
    const reconciled = controller.reconcileTerminal("The answer is 42.");
    expect(reconciled).toBe("The answer is 42.");
    controller.dispose();
  });

  it("retains failed segments and merges them into terminal delivery", () => {
    vi.useFakeTimers();
    const { controller } = makeHarness();
    controller.segmentFailed("First attempt text.");
    const reconciled = controller.reconcileTerminal("Final answer.");
    expect(reconciled).toBe("First attempt text.\n\nFinal answer.");
    controller.dispose();
  });

  it("does not duplicate a failed segment already present in the terminal", () => {
    vi.useFakeTimers();
    const { controller } = makeHarness();
    controller.segmentFailed("Final answer.");
    expect(controller.reconcileTerminal("Final answer.")).toBe("Final answer.");
    controller.dispose();
  });

  it("thinking never enters terminal reconciliation", () => {
    vi.useFakeTimers();
    const { controller } = makeHarness();
    controller.accept({ kind: "thinking", text: "secret reasoning" });
    controller.segmentDelivered("Let me search.");
    const reconciled = controller.reconcileTerminal("Let me search.\n\nFinal answer.");
    expect(reconciled).not.toContain("secret");
    expect(reconciled).toBe("Final answer.");
    controller.dispose();
  });

  it("end() flushes pending thinking and stops the timer", async () => {
    vi.useFakeTimers();
    const { controller, sent } = makeHarness();
    controller.accept({ kind: "thinking", text: "last thoughts" });
    controller.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.length).toBe(1);
    expect(controller.timerActive).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.length).toBe(1);
  });

  it("dispose() stops the timer and drops pending progress", async () => {
    vi.useFakeTimers();
    const { controller, sent } = makeHarness();
    controller.accept({ kind: "thinking", text: "pending" });
    controller.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.length).toBe(0);
    expect(controller.timerActive).toBe(false);
  });
});

describe("isIncrementalEligible", () => {
  it("allows only direct authenticated master turns outside the TUI", () => {
    expect(isIncrementalEligible({ role: "master", isGroup: false, platform: "telegram" })).toBe(true);
    expect(isIncrementalEligible({ role: "master", isGroup: true, platform: "telegram" })).toBe(false);
    expect(isIncrementalEligible({ role: "master", isGroup: false, platform: "tui" })).toBe(false);
    expect(isIncrementalEligible({ role: "guest", isGroup: false, platform: "telegram" })).toBe(false);
    expect(isIncrementalEligible({ role: undefined, isGroup: false, platform: "telegram" })).toBe(false);
    expect(isIncrementalEligible({ role: "master", isGroup: false, platform: "discord" })).toBe(true);
  });
});
