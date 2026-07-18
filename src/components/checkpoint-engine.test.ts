/**
 * checkpoint-engine.test.ts — #1335 checkpoint selection / boundary tests.
 *
 * Covers findings #3 (atomic + budget-aware selection) and #5 (firstKeptMessageId
 * from the real suffix ID, not sourceEnd + 1). Uses a mock CheckpointStore so the
 * engine's selection logic is exercised without a live abmind DB.
 */

import { describe, it, expect } from "vitest";
import { CheckpointEngine } from "./checkpoint-engine.js";
import type { CheckpointStore, CheckpointRecord, StableContextView } from "abmind";

interface CommitCall {
  chatId: string;
  record: Omit<CheckpointRecord, "id" | "createdAt" | "chatId">;
  expectedGeneration: number;
}

function makeMockStore() {
  let activePointer: { checkpointId: number; generation: number } | null = null;
  const checkpoints = new Map<number, CheckpointRecord>();
  const commits: CommitCall[] = [];
  let nextId = 1;
  const store = {
    getActivePointer: (chatId: string) =>
      activePointer
        ? { chatId, checkpointId: activePointer.checkpointId, generation: activePointer.generation, updatedAt: 0 }
        : null,
    getCheckpoint: (id: number) => checkpoints.get(id) ?? null,
    commitCheckpoint: (
      chatId: string,
      record: Omit<CheckpointRecord, "id" | "createdAt" | "chatId">,
      expectedGeneration: number,
    ): number => {
      const id = nextId++;
      checkpoints.set(id, { id, chatId, createdAt: 0, ...record });
      commits.push({ chatId, record, expectedGeneration });
      activePointer = { checkpointId: id, generation: expectedGeneration + 1 };
      return id;
    },
    getStableContext: (
      _chatId: string,
      messages: Array<{ id: number; role: string; content: string }>,
    ): StableContextView => ({
      messages,
      estimatedTokens: messages.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0),
      stablePrefixDigest: "mock",
      rendererVersion: "checkpoint-v1",
    }),
    resetCheckpoints: () => { activePointer = null; },
    commits,
  };
  return store;
}

function makeEngine() {
  const store = makeMockStore();
  // summarize returns a short summary (well under source size → passes the
  // inflation guard) that echoes the source length so assertions can read it.
  const summarize = async (sourceText: string) => `Summary of ${sourceText.length} chars.`;
  const engine = new CheckpointEngine({
    checkpointStore: store as unknown as CheckpointStore,
    summarize,
    promptVersion: "v1",
    serializerVersion: "v1",
  });
  return { engine, store };
}

/** Build N complete user→assistant turns. `gap` makes IDs non-contiguous so the
 *  sourceEnd+1 bug (#1335 finding #5) is detectable. */
function makeTurns(n: number, opts: { perMsgChars?: number; gap?: number } = {}): Array<{ id: number; role: string; content: string }> {
  const perMsgChars = opts.perMsgChars ?? 400; // ~100 tokens/message
  const gap = opts.gap ?? 0;
  const msgs: Array<{ id: number; role: string; content: string }> = [];
  let id = 10;
  for (let t = 0; t < n; t++) {
    msgs.push({ id, role: "user", content: "u".repeat(perMsgChars) });
    id += 1 + gap;
    msgs.push({ id, role: "assistant", content: "a".repeat(perMsgChars) });
    id += 1 + gap;
  }
  return msgs;
}

describe("CheckpointEngine.maybeCompact (#1335 findings #3, #5)", () => {
  it("returns -1 when fewer than two turns exist", async () => {
    const { engine } = makeEngine();
    const r = await engine.maybeCompact("c", makeTurns(1), {
      maxHistoryTokens: 1, minRecentTokens: 1, reason: "headroom", activeModel: "m",
    });
    expect(r).toBe(-1);
  });

  it("returns -1 when the stable context already fits the history budget (maxHistoryTokens consumed)", async () => {
    const { engine, store } = makeEngine();
    // 4 turns × ~200 tokens = ~800 tokens total; budget 10_000 → fits.
    const r = await engine.maybeCompact("c", makeTurns(4), {
      maxHistoryTokens: 10_000, minRecentTokens: 200, reason: "headroom", activeModel: "m",
    });
    expect(r).toBe(-1);
    expect(store.commits.length).toBe(0);
  });

  it("compacts oldest complete turns, retains the minimum recent suffix, and uses the real suffix ID (#1335 #3,#5)", async () => {
    // Non-contiguous IDs (gap=40): turns at (10,51),(92,133),(174,215),(256,297).
    const { engine, store } = makeEngine();
    const msgs = makeTurns(4, { gap: 40 });
    // total ~800 tokens, budget 300 → compaction needed; minRecentTokens 200
    // retains the most recent turn (~200 tokens).
    const r = await engine.maybeCompact("c", msgs, {
      maxHistoryTokens: 300, minRecentTokens: 200, reason: "headroom", activeModel: "m",
    });
    expect(r).toBeGreaterThan(0);
    expect(store.commits.length).toBe(1);
    const rec = store.commits[0]!.record;
    // Source spans the first three complete turns only (whole turns).
    expect(rec.sourceMessageStart).toBe(10);
    expect(rec.sourceMessageEnd).toBe(215); // end of 3rd turn (id 174,215)
    // #1335 finding #5: firstKeptMessageId is the real first suffix message ID
    // (4th turn starts at 256), NOT sourceEnd + 1 (216).
    expect(rec.firstKeptMessageId).toBe(256);
    expect(rec.firstKeptMessageId).not.toBe(rec.sourceMessageEnd + 1);
  });

  it("keeps an in-turn tool exchange atomic — never splits assistant tool-call from its results", async () => {
    // One turn containing an assistant tool-call + tool result + assistant final,
    // followed by a second plain turn. Non-contiguous IDs.
    const msgs: Array<{ id: number; role: string; content: string }> = [
      { id: 10, role: "user", content: "u".repeat(400) },
      { id: 11, role: "assistant", content: "calling tools".repeat(40) },
      { id: 60, role: "tool", content: "t".repeat(400) },
      { id: 61, role: "assistant", content: "a".repeat(400) }, // final → turn complete
      { id: 110, role: "user", content: "u".repeat(400) },
      { id: 111, role: "assistant", content: "a".repeat(400) },
    ];
    const { engine, store } = makeEngine();
    // Force compaction but retain only the last turn (~200 tokens).
    const r = await engine.maybeCompact("c", msgs, {
      maxHistoryTokens: 300, minRecentTokens: 200, reason: "headroom", activeModel: "m",
    });
    expect(r).toBeGreaterThan(0);
    const rec = store.commits[0]!.record;
    // The whole tool-exchange turn (ids 10..61) is the compacted source; the
    // tool result (id 60) is never split off from its assistant tool-call (11).
    expect(rec.sourceMessageStart).toBe(10);
    expect(rec.sourceMessageEnd).toBe(61);
    expect(rec.firstKeptMessageId).toBe(110);
  });

  it("does not compact an incomplete trailing turn (no final assistant)", async () => {
    // Two complete turns, then an unanswered user message (in-flight).
    const msgs = makeTurns(2, { gap: 40 });
    msgs.push({ id: 999, role: "user", content: "u".repeat(400) });
    const { engine, store } = makeEngine();
    const r = await engine.maybeCompact("c", msgs, {
      maxHistoryTokens: 100, minRecentTokens: 1, reason: "headroom", activeModel: "m",
    });
    expect(r).toBeGreaterThan(0);
    const rec = store.commits[0]!.record;
    // Only the two complete turns are compacted; the incomplete user (999) is
    // retained as the suffix start.
    expect(rec.sourceMessageEnd).toBeLessThan(999);
    expect(rec.firstKeptMessageId).toBe(999);
  });

  it("bypasses the budget gate for manual compaction", async () => {
    const { engine, store } = makeEngine();
    // Fits comfortably, but manual reason forces a checkpoint attempt.
    const r = await engine.maybeCompact("c", makeTurns(4), {
      maxHistoryTokens: 1_000_000, minRecentTokens: 200, reason: "manual", activeModel: "m",
    });
    expect(r).toBeGreaterThan(0);
    expect(store.commits.length).toBe(1);
    expect(store.commits[0]!.record.reason).toBe("manual");
  });

  it("rejects an inflating summary (checkpoint not smaller than source)", async () => {
    const store = makeMockStore();
    const engine = new CheckpointEngine({
      checkpointStore: store as unknown as CheckpointStore,
      summarize: async (sourceText: string) => sourceText, // same size → inflation
      promptVersion: "v1",
      serializerVersion: "v1",
    });
    const r = await engine.maybeCompact("c", makeTurns(4), {
      maxHistoryTokens: 100, minRecentTokens: 50, reason: "headroom", activeModel: "m",
    });
    expect(r).toBe(-1);
    expect(store.commits.length).toBe(0);
  });
});
