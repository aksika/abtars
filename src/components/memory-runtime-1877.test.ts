/**
 * #1877 — injection rule: flag carry, single predicate, tool-contract strip.
 *
 * Protection: the 36 h trivial-fact exemption must actually fire on flagged
 * old facts (the #502 intent) while unflagged old facts stay suppressed;
 * the tool contract must stay byte-identical on the same store.
 */
import { describe, it, expect, vi, type Mock } from "vitest";
import {
  createClientRuntime,
  shouldInjectRecallHit,
  asRecallFlag,
  stripRecallFlagsForTool,
  TRIVIAL_FACT_TTL_MS,
  type RuntimeRecallHit,
} from "./memory-runtime.js";

const DAY = 86400000;

function caps(methods: string[], features: Record<string, string> = {}) {
  return { capabilities: { version: 1, methods, features } };
}

function mockClient() {
  return {
    ...caps(["private.recall"], { private_read: "true" }),
    routeSnapshot: {},
    privateMemory: { recall: vi.fn() },
    sleep: {},
    negotiate: async () => ({}),
    close: async () => {},
  };
}

describe("#1877 shouldInjectRecallHit — one owner for the floor/age rule", () => {
  it("rejects at/below the floor regardless of flags", () => {
    const now = Date.now();
    expect(shouldInjectRecallHit({ score: 0.70, memoryType: "fact", createdAt: now }, now)).toBe(false);
    expect(shouldInjectRecallHit({ score: 0.5, memoryType: "fact", createdAt: now, importanceFlags: "standing-constraint" }, now)).toBe(false);
  });

  it("drops the same old low-score fact without flags, injects it with flags (age branch, not floor)", () => {
    const now = Date.now();
    const old = now - 30 * DAY;
    // 0.85 clears the 0.70 floor and stays below 1.0, so the age branch decides.
    const score = 0.85;
    expect(shouldInjectRecallHit({ score, memoryType: "fact", createdAt: old }, now)).toBe(false);
    expect(shouldInjectRecallHit({ score, memoryType: "fact", createdAt: old, importanceFlags: "standing-constraint" }, now)).toBe(true);
    expect(shouldInjectRecallHit({ score, memoryType: "fact", createdAt: old, emotionTags: "joy" }, now)).toBe(true);
  });

  it("injects a recent fact either way", () => {
    const now = Date.now();
    const recent = now - 1 * DAY;
    expect(now - recent).toBeLessThan(TRIVIAL_FACT_TTL_MS);
    expect(shouldInjectRecallHit({ score: 0.85, memoryType: "fact", createdAt: recent }, now)).toBe(true);
    expect(shouldInjectRecallHit({ score: 0.85, memoryType: "fact", createdAt: recent, importanceFlags: "standing-constraint" }, now)).toBe(true);
  });

  it("leaves non-facts and scoreless-boundary inputs alone", () => {
    const now = Date.now();
    const old = now - 30 * DAY;
    expect(shouldInjectRecallHit({ score: 0.85, memoryType: "note", createdAt: old }, now)).toBe(true);
    expect(shouldInjectRecallHit({ score: 0.85 }, now)).toBe(true);
    // createdAt 0 is "no timestamp" (truthy test as in the original rule):
    // it never enters the age branch, so the fact injects unchanged.
    expect(shouldInjectRecallHit({ score: 0.85, memoryType: "fact", createdAt: 0 }, now)).toBe(true);
  });
});

describe("#1877 asRecallFlag — narrow validation", () => {
  it("drops non-strings, trims, treats empty-after-trim as absent, bounds length", () => {
    expect(asRecallFlag(42)).toBeUndefined();
    expect(asRecallFlag(null)).toBeUndefined();
    expect(asRecallFlag("   ")).toBeUndefined();
    expect(asRecallFlag(" standing-constraint ")).toBe("standing-constraint");
    const long = "x".repeat(500);
    expect(asRecallFlag(long)).toHaveLength(256);
  });
});

describe("#1877 flag carry across the runtime boundary", () => {
  it("forwards validated flags; malformed wire values recall as ordinary", async () => {
    const client = mockClient();
    (client.privateMemory.recall as unknown as Mock).mockResolvedValue({
      results: [
        { content: "flagged", score: 0.9, date: "2026-09-01", id: 1, emotionTags: " joy ", importanceFlags: "standing-constraint" },
        { content: "malformed", score: 0.9, date: "2026-09-01", id: 2, emotionTags: 42, importanceFlags: "   " },
      ],
    });
    const rt = createClientRuntime(client as never);
    const res = await rt.recall({ query: "q", userId: "u1" });
    expect(res.hits[0]?.emotionTags).toBe("joy");
    expect(res.hits[0]?.importanceFlags).toBe("standing-constraint");
    expect(res.hits[1]?.emotionTags).toBeUndefined();
    expect(res.hits[1]?.importanceFlags).toBeUndefined();
  });
});

describe("#1877 stripRecallFlagsForTool — tool contract preserved", () => {
  it("removes exactly the two carried fields and does not mutate input", () => {
    const hits = [{ content: "c", score: 0.9, date: "d", memoryId: 1, emotionTags: "joy", importanceFlags: "x" }];
    const stripped = stripRecallFlagsForTool(hits);
    expect(stripped[0]).not.toHaveProperty("emotionTags");
    expect(stripped[0]).not.toHaveProperty("importanceFlags");
    expect(stripped[0]).toMatchObject({ content: "c", score: 0.9, memoryId: 1 });
    expect(hits[0]).toHaveProperty("emotionTags");
  });

  it("serialized tool output is byte-identical with and without carried flags", () => {
    const baseHit: RuntimeRecallHit = { content: "c", score: 0.9, date: "d", memoryId: 1 };
    const base = { hits: [baseHit], context: "ctx" };
    const withFlags = { ...base, hits: [{ ...baseHit, emotionTags: "joy", importanceFlags: "x" }] };
    const a = JSON.stringify({ ...base, hits: stripRecallFlagsForTool(base.hits) });
    const b = JSON.stringify({ ...withFlags, hits: stripRecallFlagsForTool(withFlags.hits) });
    expect(a).toBe(b);
  });
});

describe("#1877 skip signal carry — abmind decides, the bridge only reports", () => {
  async function recallWith(raw: Record<string, unknown>) {
    const client = mockClient();
    (client.privateMemory.recall as Mock).mockResolvedValue({ results: [], ...raw });
    const runtime = createClientRuntime(client as never);
    return runtime.recall({ query: "q", userId: "u1", limit: 5, terms: ["thanks"], selectTerms: true });
  }

  it("carries a reported skip with its reason", async () => {
    const res = await recallWith({ searchSkipped: true, searchSkippedReason: "no-informative-terms" });
    expect(res.searchSkipped).toBe(true);
    expect(res.searchSkippedReason).toBe("no-informative-terms");
    expect(res.hits).toEqual([]);
  });

  it("an ordinary empty result reports no skip", async () => {
    const res = await recallWith({});
    expect(res.searchSkipped).toBeUndefined();
    expect(res.searchSkippedReason).toBeUndefined();
  });

  it("malformed wire values degrade to ordinary recall", async () => {
    const truthy = await recallWith({ searchSkipped: "yes", searchSkippedReason: "no-informative-terms" });
    expect(truthy.searchSkipped).toBeUndefined();
    expect(truthy.searchSkippedReason).toBeUndefined();
    const badReason = await recallWith({ searchSkipped: true, searchSkippedReason: { nope: 1 } });
    expect(badReason.searchSkipped).toBe(true);
    expect(badReason.searchSkippedReason).toBeUndefined();
  });
});
