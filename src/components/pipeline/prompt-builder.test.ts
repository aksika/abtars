import { describe, it, expect, vi } from "vitest";
import { buildPrompt } from "./prompt-builder.js";
import { createDisabledRuntime } from "../memory-runtime.js";

vi.mock("../spin.js", () => ({ spin: { getSessionById: vi.fn(() => undefined) } }));

function readyRuntime(recordMessage: ReturnType<typeof vi.fn>) {
  return {
    state: "ready",
    capabilities: new Set(["durableContext"]),
    recordMessage,
    assembleSessionContext: vi.fn().mockResolvedValue({ coreKnowledge: "", recall: "", wakeUp: "" }),
  } as never;
}

function baseDeps(runtime: unknown, memoryEnabled = true) {
  return {
    memoryRuntime: runtime,
    memoryConfig: { memoryEnabled, memoryDir: "/tmp" },
    sessionManager: { getActiveSessionId: () => "master_A_1" },
    conversationBuffer: { drain: () => "" },
    contextPercent: -1,
  } as never;
}

function masterRegistry() {
  return { byUserId: new Map([["master", { role: "master" }]]) } as never;
}

describe("buildPrompt", () => {
  it("uses the explicit disabled runtime without a manager-shaped memory object", async () => {
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false } as never,
      "hello",
      {
        memoryRuntime: createDisabledRuntime(),
        memoryConfig: { memoryEnabled: false, memoryDir: "" },
        sessionManager: { getActiveSessionId: () => "master_A_1" },
        conversationBuffer: { drain: () => "" },
        contextPercent: -1,
      } as never,
      masterRegistry(),
    );
    expect(result.prompt).toContain("hello");
    expect(result.durableContextIntent).toEqual({ mode: "not_required" });
  });
});

// ── #1813 compact injection ───────────────────────────────────────────────────

describe("#1813 — compact evidence injection", () => {
  const LONG_A = `Production deploys go through the pipeline. ${"a".repeat(1600)}`;
  const LONG_B = `Rollbacks restore the previous release. ${"b".repeat(1600)}`;
  const CONSTRAINT = "Ask the operator before deploying changes to the production database.";

  function recallRuntime(recall: ReturnType<typeof vi.fn>) {
    return {
      state: "ready",
      capabilities: new Set(["durableContext"]),
      recordMessage: vi.fn().mockResolvedValue({ id: 1 }),
      recall,
      assembleSessionContext: vi.fn().mockResolvedValue({ coreKnowledge: "", recall: "", wakeUp: "" }),
    } as never;
  }

  function hits() {
    return [
      { content: LONG_A, score: 1.3, date: "", memoryId: 1 },
      { content: LONG_B, score: 1.2, date: "", memoryId: 2 },
      { content: CONSTRAINT, score: 1.1, date: "", memoryId: 3 },
    ];
  }

  function memoryBlock(prompt: string): string {
    const match = prompt.match(/\[MEMORY CONTEXT[^\]]*\][\s\S]*?\[\/MEMORY CONTEXT\]/);
    if (!match) throw new Error(`no memory block in prompt: ${prompt.slice(0, 200)}`);
    return match[0];
  }

  it("injects the bounded selection and reduces payload while keeping the constraint", async () => {
    const fullRecall = vi.fn().mockResolvedValue({ hits: hits(), context: "" });
    const full = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false } as never,
      "how do I deploy",
      baseDeps(recallRuntime(fullRecall)),
      masterRegistry(),
    );

    const compactRecall = vi.fn().mockResolvedValue({
      hits: hits(),
      context: "",
      selection: {
        version: 1,
        refs: [{ id: 3, revision: 1 }],
        budgetBytes: 2000,
        truncated: true,
      },
    });
    const compact = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false } as never,
      "how do I deploy",
      baseDeps(recallRuntime(compactRecall)),
      masterRegistry(),
    );

    const fullBlock = memoryBlock(full.prompt);
    const compactBlock = memoryBlock(compact.prompt);
    expect(compactBlock).toContain(CONSTRAINT);
    expect(compactBlock).not.toContain("aaaa");
    expect(compactBlock.length).toBeLessThan(fullBlock.length);
    // Only injected rows are reported as recalled hits.
    expect(compact.recalledHits).toEqual([{ id: 3, contentEn: CONSTRAINT }]);
    expect(full.recalledHits?.length).toBe(3);
  });

  it("falls back to every filtered hit when selection is absent", async () => {
    const recall = vi.fn().mockResolvedValue({ hits: hits(), context: "" });
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false } as never,
      "how do I deploy",
      baseDeps(recallRuntime(recall)),
      masterRegistry(),
    );
    const block = memoryBlock(result.prompt);
    expect(block).toContain(CONSTRAINT);
    expect(block).toContain("aaaa");
    expect(result.recalledHits?.length).toBe(3);
  });

  it("falls back when selection refs resolve to none of the delivered hits", async () => {
    const recall = vi.fn().mockResolvedValue({
      hits: hits(),
      context: "",
      selection: { version: 1, refs: [{ id: 99, revision: 1 }], budgetBytes: 2000, truncated: false },
    });
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false } as never,
      "how do I deploy",
      baseDeps(recallRuntime(recall)),
      masterRegistry(),
    );
    expect(memoryBlock(result.prompt)).toContain("aaaa");
    expect(result.recalledHits?.length).toBe(3);
  });
});

// ── #1908 ambient recall: no bridge-side raw-only precheck ─────────────────
// A raw-only host verdict must never terminate a turn that informative
// context would rescue, so the bridge does not consult the cheap check on
// the ambient path at all. The daemon's ambient planner owns the combined
// skip (raw, hints, eligible context); worthRetrieving stays for CLI and
// explicit precheck uses.

describe("#1908 — ambient recall skips only on the engine verdict", () => {
  function ambientRuntime(recall: ReturnType<typeof vi.fn>) {
    return {
      state: "ready",
      capabilities: new Set(["durableContext"]),
      recordMessage: vi.fn().mockResolvedValue({ id: 1 }),
      worthRetrieving: vi.fn().mockResolvedValue({ verdict: "skip", corpusSize: 14, ceiling: 3 }),
      recall,
      assembleSessionContext: vi.fn().mockResolvedValue({ coreKnowledge: "", recall: "", wakeUp: "" }),
    } as never;
  }

  function turnDeps(runtime: unknown, dispatchBackground?: ReturnType<typeof vi.fn>) {
    return {
      memoryRuntime: runtime,
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" },
      sessionManager: {
        getActiveSessionId: () => "master_A_1",
        ...(dispatchBackground !== undefined ? { dispatchBackground } : {}),
      },
      conversationBuffer: { drain: () => "" },
      contextPercent: -1,
    } as never;
  }

  function turn(runtime: unknown, text: string, dispatchBackground?: ReturnType<typeof vi.fn>) {
    return buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false } as never,
      text,
      turnDeps(runtime, dispatchBackground),
      masterRegistry(),
    );
  }

  it("never consults the cheap check; an engine skip injects nothing", async () => {
    const recall = vi.fn().mockResolvedValue({ hits: [], context: "", searchSkipped: true, searchSkippedReason: "no-informative-terms" });
    const runtime = ambientRuntime(recall);
    const result = await turn(runtime, "köszi");
    expect((runtime as { worthRetrieving: ReturnType<typeof vi.fn> }).worthRetrieving).not.toHaveBeenCalled();
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ intent: "ambient", original: "köszi" }));
    expect(result.prompt).not.toContain("MEMORY CONTEXT");
    expect(result.recalledHits).toBeUndefined();
  });

  it("a search verdict runs one ambient recall and never touches a model", async () => {
    const dispatchBackground = vi.fn();
    const recall = vi.fn().mockResolvedValue({ hits: [], context: "" });
    const runtime = ambientRuntime(recall);
    await turn(runtime, "köszi migrációs terv", dispatchBackground);
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ intent: "ambient", original: "köszi migrációs terv" }));
    expect(dispatchBackground).not.toHaveBeenCalled();
  });

  it("a runtime without the check (older shape) recalls ordinarily", async () => {
    const recall = vi.fn().mockResolvedValue({ hits: [], context: "" });
    const legacy = {
      state: "ready",
      capabilities: new Set(["durableContext"]),
      recordMessage: vi.fn().mockResolvedValue({ id: 1 }),
      recall,
      assembleSessionContext: vi.fn().mockResolvedValue({ coreKnowledge: "", recall: "", wakeUp: "" }),
    } as never;
    const result = await turn(legacy, "köszi");
    expect(recall).toHaveBeenCalledTimes(1);
    expect(result.prompt).not.toContain("MEMORY CONTEXT");
  });
});

describe("buildPrompt durable-context classification (#1529)", () => {
  it("maps a numeric record ID to durable intent with that exact cursor", async () => {
    const recordMessage = vi.fn().mockResolvedValue({ id: 42 });
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: "m1" } as never,
      "hello",
      baseDeps(readyRuntime(recordMessage)),
      masterRegistry(),
    );
    expect(result.durableContextIntent).toEqual({ mode: "durable", beforeMessageId: 42 });
    expect(recordMessage).toHaveBeenCalledTimes(1);
  });

  it("maps a rejected inbound write to required_unavailable/record_failed", async () => {
    const recordMessage = vi.fn().mockRejectedValue(new Error("owner down"));
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: "m2" } as never,
      "hello",
      baseDeps(readyRuntime(recordMessage)),
      masterRegistry(),
    );
    expect(result.durableContextIntent).toEqual({ mode: "required_unavailable", reason: "record_failed" });
  });

  it("maps a null record ID to required_unavailable/cursor_missing", async () => {
    const recordMessage = vi.fn().mockResolvedValue({ id: null });
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: "m3" } as never,
      "hello",
      baseDeps(readyRuntime(recordMessage)),
      masterRegistry(),
    );
    expect(result.durableContextIntent).toEqual({ mode: "required_unavailable", reason: "cursor_missing" });
  });

  it("maps a configured durable turn with a not-ready runtime to required_unavailable/runtime_unavailable", async () => {
    const notReady = { state: "unavailable" as const, capabilities: new Set<string>() } as never;
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: "m4" } as never,
      "hello",
      baseDeps(notReady),
      masterRegistry(),
    );
    expect(result.durableContextIntent).toEqual({ mode: "required_unavailable", reason: "runtime_unavailable" });
  });

  it("maps disabled memory to not_required even for a master turn", async () => {
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: "m5" } as never,
      "hello",
      baseDeps(createDisabledRuntime(), false),
      masterRegistry(),
    );
    expect(result.durableContextIntent).toEqual({ mode: "not_required" });
  });

  it("maps guest turns to not_required", async () => {
    const recordMessage = vi.fn().mockResolvedValue({ id: 1 });
    const result = await buildPrompt(
      { userId: "guest1", channelId: "1", platform: "telegram", isGroup: false, messageId: "m6" } as never,
      "hello",
      baseDeps(readyRuntime(recordMessage)),
      { byUserId: new Map([["guest1", { role: "guest" }]]) } as never,
    );
    expect(result.durableContextIntent).toEqual({ mode: "not_required" });
    expect(recordMessage).not.toHaveBeenCalled();
  });

  it("maps [SESSION START] synthetic turns to not_required", async () => {
    const recordMessage = vi.fn().mockResolvedValue({ id: 1 });
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: "m7" } as never,
      "[SESSION START] You just came online.",
      baseDeps(readyRuntime(recordMessage)),
      masterRegistry(),
    );
    expect(result.durableContextIntent).toEqual({ mode: "not_required" });
    expect(recordMessage).not.toHaveBeenCalled();
  });

  it("maps skill-isolated K sessions to not_required", async () => {
    const recordMessage = vi.fn().mockResolvedValue({ id: 1 });
    const kSession = {
      id: "master_K_1", userId: "master", platform: "telegram", chatId: 100,
      seen: true, pendingStart: false,
    } as never;
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: "m8" } as never,
      "hello",
      baseDeps(readyRuntime(recordMessage)),
      masterRegistry(),
      kSession,
    );
    expect(result.durableContextIntent).toEqual({ mode: "not_required" });
    expect(recordMessage).not.toHaveBeenCalled();
  });
});

describe("buildPrompt session-context request (#1776)", () => {
  it("forwards the full model window as modelContextTokens without pre-scaling", async () => {
    const assembleSessionContext = vi.fn().mockResolvedValue({ coreKnowledge: "", recall: "", wakeUp: "" });
    const recordMessage = vi.fn().mockResolvedValue({ id: 7 });
    const runtime = {
      state: "ready",
      capabilities: new Set(["durableContext"]),
      recordMessage,
      assembleSessionContext,
    } as never;
    const deps = { ...(baseDeps(runtime) as Record<string, unknown>), maxContext: 128000 } as never;
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: "hydra-1" } as never,
      "hello",
      deps,
      masterRegistry(),
    );
    expect(result.isSessionStart).toBe(true);
    expect(assembleSessionContext).toHaveBeenCalledTimes(1);
    const input = assembleSessionContext.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({ modelContextTokens: 128000 });
    expect(input).not.toHaveProperty("maxChars");
  });
});

// ── #1869 split session-start ───────────────────────────────────────────────
// The Main session carries each core part exactly once across both channels:
// boot owns soul + memoryTools (soul-bundle.test.ts asserts the mutable parts
// are absent there); session-start owns profile/notes/coreFacts here and must
// never re-inject soul/memoryTools.

describe("#1869 — session-start owns profile/notes/coreFacts via parts", () => {
  const PARTS = {
    soul: "SOUL-1869", profile: "PROFILE-1869", notes: "NOTES-1869",
    memoryTools: "TOOLS-1869", coreFacts: "FACTS-1869",
  };

  function partsRuntime(shape: unknown) {
    return {
      state: "ready",
      capabilities: new Set(["durableContext"]),
      recordMessage: vi.fn().mockResolvedValue({ id: 1 }),
      assembleSessionContext: vi.fn().mockResolvedValue(shape),
    } as never;
  }

  function sessionMsg() {
    return { userId: "master", channelId: "1", platform: "telegram", isGroup: false } as never;
  }

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("injects profile/notes/coreFacts exactly once each, never soul/memoryTools", async () => {
    const result = await buildPrompt(
      sessionMsg(),
      "hello",
      baseDeps(partsRuntime({
        coreKnowledge: "LEGACY-1869", recall: "RECALL-1869", wakeUp: "WAKE-1869",
        soulBundle: PARTS, parts: PARTS,
      })),
      masterRegistry(),
    );
    const prompt = result.prompt;
    for (const marker of ["PROFILE-1869", "NOTES-1869", "FACTS-1869", "RECALL-1869", "WAKE-1869"]) {
      expect(countOccurrences(prompt, marker)).toBe(1);
    }
    expect(prompt).not.toContain("SOUL-1869");
    expect(prompt).not.toContain("TOOLS-1869");
    expect(prompt).not.toContain("LEGACY-1869");
    const idx = (s: string): number => prompt.indexOf(s);
    expect(idx("PROFILE-1869")).toBeLessThan(idx("NOTES-1869"));
    expect(idx("NOTES-1869")).toBeLessThan(idx("FACTS-1869"));
    expect(idx("FACTS-1869")).toBeLessThan(idx("RECALL-1869"));
    expect(idx("RECALL-1869")).toBeLessThan(idx("WAKE-1869"));
  });

  it("falls back to the legacy joined field when parts are absent (old daemon)", async () => {
    const result = await buildPrompt(
      sessionMsg(),
      "hello",
      baseDeps(partsRuntime({ coreKnowledge: "LEGACY-1869", recall: "", wakeUp: "" })),
      masterRegistry(),
    );
    expect(result.prompt).toContain("LEGACY-1869");
  });

  it("falls back to legacy when parts are malformed, never a partial bundle", async () => {
    const result = await buildPrompt(
      sessionMsg(),
      "hello",
      baseDeps(partsRuntime({
        coreKnowledge: "LEGACY-1869", recall: "", wakeUp: "",
        parts: { soul: 1, profile: null, notes: "x", memoryTools: "y", coreFacts: "z" },
      })),
      masterRegistry(),
    );
    expect(result.prompt).toContain("LEGACY-1869");
  });
});

describe("#1869 — post-compaction core rehydration is core-only", () => {
  const PARTS = {
    soul: "SOUL-REHY", profile: "PROFILE-REHY", notes: "NOTES-REHY",
    memoryTools: "TOOLS-REHY", coreFacts: "FACTS-REHY",
  };

  /** An established session: already seen, no pending start, but flagged for
   *  core rehydration by a completed compaction. */
  function rehydrateSession(overrides: Record<string, unknown> = {}) {
    return {
      id: "master_A_1", userId: "master", platform: "telegram", chatId: 100,
      seen: true, pendingStart: false, pendingCoreRehydrate: true,
      ...overrides,
    } as never;
  }

  function runtimeFor(shape: unknown, assemble = vi.fn().mockResolvedValue(shape)) {
    return {
      runtime: {
        state: "ready",
        capabilities: new Set(["durableContext"]),
        recordMessage: vi.fn().mockResolvedValue({ id: 1 }),
        assembleSessionContext: assemble,
      } as never,
      assemble,
    };
  }

  const msg = () => ({ userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: "rehy-1" } as never);

  it("re-injects the core parts without the history hydration that compaction just reduced", async () => {
    const { runtime, assemble } = runtimeFor({
      coreKnowledge: "", recall: "RECALL-REHY", wakeUp: "WAKE-REHY",
      soulBundle: PARTS, parts: PARTS,
    });
    const session = rehydrateSession();
    const result = await buildPrompt(msg(), "hello", baseDeps(runtime), masterRegistry(), session);

    expect(result.isSessionStart).toBe(false);
    for (const marker of ["PROFILE-REHY", "NOTES-REHY", "FACTS-REHY"]) {
      expect(result.prompt).toContain(marker);
    }
    // The point of the narrow path: no consolidations, no message pairs, no
    // flashback re-added on top of a summary that already covers them.
    expect(result.prompt).not.toContain("RECALL-REHY");
    expect(result.prompt).not.toContain("WAKE-REHY");
    // Immutable parts stay in the compaction-immune system prompt.
    expect(result.prompt).not.toContain("SOUL-REHY");
    expect(result.prompt).not.toContain("TOOLS-REHY");
    // Structural guarantee, not a filter: abmind never builds the hydration.
    expect(assemble.mock.calls[0]![0]).toMatchObject({ includeHistory: false });
    // One-shot.
    expect((session as unknown as { pendingCoreRehydrate: boolean }).pendingCoreRehydrate).toBe(false);
  });

  it("is a no-op against an older daemon, whose system prompt still carries the parts", async () => {
    const { runtime } = runtimeFor({ coreKnowledge: "LEGACY-REHY", recall: "", wakeUp: "" });
    const result = await buildPrompt(msg(), "hello", baseDeps(runtime), masterRegistry(), rehydrateSession());
    // Re-injecting here would duplicate what the legacy system prompt holds.
    expect(result.prompt).not.toContain("LEGACY-REHY");
  });

  it("does not fire on an ordinary turn", async () => {
    const { runtime, assemble } = runtimeFor({
      coreKnowledge: "", recall: "", wakeUp: "", soulBundle: PARTS, parts: PARTS,
    });
    const result = await buildPrompt(
      msg(), "hello", baseDeps(runtime), masterRegistry(),
      rehydrateSession({ pendingCoreRehydrate: false }),
    );
    expect(assemble).not.toHaveBeenCalled();
    expect(result.prompt).not.toContain("PROFILE-REHY");
  });
});
