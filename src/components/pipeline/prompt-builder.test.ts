import { describe, it, expect, vi } from "vitest";
import { buildPrompt } from "./prompt-builder.js";
import { createDisabledRuntime } from "../memory-runtime.js";
import { PiArchiveOutbox } from "../pi-session/pi-archive-outbox.js";

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
    // #1932: isolate the live-process archive outbox by default.
    archiveOutbox: new PiArchiveOutbox(),
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

describe("#1928 — owner packet injection", () => {
  const LONG_A = `Production deploys go through the pipeline. ${"a".repeat(1600)}`;
  const LONG_B = `Rollbacks restore the previous release. ${"b".repeat(1600)}`;
  const CONSTRAINT = "Ask the operator before deploying changes to the production database.";
  const OWNER_TEXT = "[1] (db:durable:3:u1:1) Ask the operator before deploying changes to the production database.";

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
      { ref: "db:durable:1:u1:1", kind: "db", content: LONG_A, date: "" },
      { ref: "db:durable:2:u1:1", kind: "db", content: LONG_B, date: "" },
      { ref: "db:durable:3:u1:1", kind: "db", content: CONSTRAINT, date: "" },
    ];
  }

  function memoryBlock(prompt: string): string {
    const match = prompt.match(/\[MEMORY CONTEXT[^\]]*\][\s\S]*?\[\/MEMORY CONTEXT\]/);
    if (!match) throw new Error(`no memory block in prompt: ${prompt.slice(0, 200)}`);
    return match[0];
  }

  it("injects the owner text verbatim with no floors or local rendering", async () => {
    const recall = vi.fn().mockResolvedValue({ hits: hits(), context: OWNER_TEXT, status: "evidence" });
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false } as never,
      "how do I deploy",
      baseDeps(recallRuntime(recall)),
      masterRegistry(),
    );

    expect(recall).toHaveBeenCalledWith(expect.objectContaining({
      profile: "recall_fast",
      rawTurn: "how do I deploy",
      userId: "master",
    }));
    const block = memoryBlock(result.prompt);
    expect(block).toContain(OWNER_TEXT);
    expect(block).not.toContain("aaaa");
    expect(block).toContain("[SUPPORT: ref, ...]");
    expect(result.recalledHits?.map((h) => h.ref)).toEqual([
      "db:durable:1:u1:1",
      "db:durable:2:u1:1",
      "db:durable:3:u1:1",
    ]);
  });

  it("injects nothing on empty evidence, with the skip visible in the log", async () => {
    const recall = vi.fn().mockResolvedValue({ hits: [], context: "", status: "skipped", omissionReasons: [] });
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false } as never,
      "köszi",
      baseDeps(recallRuntime(recall)),
      masterRegistry(),
    );
    expect(result.prompt).not.toContain("MEMORY CONTEXT");
    expect(result.recalledHits).toBeUndefined();
  });
});

// ── #1928 fast recall: verbatim turn, owner skip verdict ───────────────────
// The bridge never pre-judges a turn: the owner fast core judges the skip and
// the prompt carries the packet verbatim or nothing at all.

describe("#1928 — fast recall carries the verbatim turn", () => {
  function fastRuntime(recall: ReturnType<typeof vi.fn>) {
    return {
      state: "ready",
      capabilities: new Set(["durableContext"]),
      recordMessage: vi.fn().mockResolvedValue({ id: 1 }),
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

  it("an owner skip injects nothing", async () => {
    const recall = vi.fn().mockResolvedValue({ hits: [], context: "", status: "skipped" });
    const runtime = fastRuntime(recall);
    const result = await turn(runtime, "köszi");
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ profile: "recall_fast", rawTurn: "köszi" }));
    expect(result.prompt).not.toContain("MEMORY CONTEXT");
    expect(result.recalledHits).toBeUndefined();
  });

  it("evidence injects the owner text and never touches a model", async () => {
    const dispatchBackground = vi.fn();
    const recall = vi.fn().mockResolvedValue({
      hits: [{ ref: "db:durable:1:u1:1", kind: "db", content: "köszi note", date: "" }],
      context: "[1] (db:durable:1:u1:1) köszi note",
      status: "evidence",
    });
    const runtime = fastRuntime(recall);
    const result = await turn(runtime, "köszi migrációs terv", dispatchBackground);
    expect(recall).toHaveBeenCalledTimes(1);
    expect(dispatchBackground).not.toHaveBeenCalled();
    expect(result.prompt).toContain("köszi note");
  });

  it("a runtime without evidence recalls ordinarily", async () => {
    const recall = vi.fn().mockResolvedValue({ hits: [], context: "", status: "empty" });
    const runtime = fastRuntime(recall);
    const result = await turn(runtime, "köszi");
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

  it("retries a pending terminal write first and proceeds on durable confirmation (ACP #1932)", async () => {
    const { PiArchiveOutbox } = await import("../pi-session/pi-archive-outbox.js");
    const outbox = new PiArchiveOutbox();
    outbox.note({
      role: "assistant",
      content: "already delivered",
      timestamp: 1,
      userId: "master",
      sessionId: "master_A_1",
      operationKey: "op-old",
    });
    const seenKeys: string[] = [];
    const recordMessage = vi.fn(async (_input: unknown, key: string) => {
      seenKeys.push(key);
      return seenKeys.length === 1 ? { id: 9 } : { id: 42 };
    });
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: "m5" } as never,
      "hello",
      { ...(baseDeps(readyRuntime(recordMessage)) as unknown as Record<string, unknown>), archiveOutbox: outbox, isAcp: true } as never,
      masterRegistry(),
    );
    expect(result.durableContextIntent).toEqual({ mode: "durable", beforeMessageId: 42 });
    expect(seenKeys[0]).toBe("op-old");
    expect(outbox.has("master_A_1")).toBe(false);
  });

  it("fails closed without recording inbound when the pending terminal retry fails (ACP #1932)", async () => {
    const { PiArchiveOutbox } = await import("../pi-session/pi-archive-outbox.js");
    const outbox = new PiArchiveOutbox();
    outbox.note({
      role: "assistant",
      content: "already delivered",
      timestamp: 1,
      userId: "master",
      sessionId: "master_A_1",
      operationKey: "op-old",
    });
    const seenKeys: string[] = [];
    const recordMessage = vi.fn(async (_input: unknown, key: string) => {
      seenKeys.push(key);
      throw new Error("owner down");
    });
    const result = await buildPrompt(
      { userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: "m6" } as never,
      "hello",
      { ...(baseDeps(readyRuntime(recordMessage)) as unknown as Record<string, unknown>), archiveOutbox: outbox, isAcp: true } as never,
      masterRegistry(),
    );
    expect(result.durableContextIntent).toEqual({ mode: "required_unavailable", reason: "record_failed" });
    expect(seenKeys).toEqual(["op-old"]);
    expect(outbox.has("master_A_1")).toBe(true);
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

  it("injects profile/notes/coreFacts exactly once each, never soul/memoryTools (ACP)", async () => {
    const result = await buildPrompt(
      sessionMsg(),
      "hello",
      { ...(baseDeps(partsRuntime({
        coreKnowledge: "LEGACY-1869", recall: "RECALL-1869", wakeUp: "WAKE-1869",
        soulBundle: PARTS, parts: PARTS,
      })) as unknown as Record<string, unknown>), isAcp: true } as never,
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

  it("falls back to the legacy joined field when parts are absent (old daemon, ACP)", async () => {
    const result = await buildPrompt(
      sessionMsg(),
      "hello",
      { ...(baseDeps(partsRuntime({ coreKnowledge: "LEGACY-1869", recall: "", wakeUp: "" })) as unknown as Record<string, unknown>), isAcp: true } as never,
      masterRegistry(),
    );
    expect(result.prompt).toContain("LEGACY-1869");
  });

  it("falls back to legacy when parts are malformed, never a partial bundle (ACP)", async () => {
    const result = await buildPrompt(
      sessionMsg(),
      "hello",
      { ...(baseDeps(partsRuntime({
        coreKnowledge: "LEGACY-1869", recall: "", wakeUp: "",
        parts: { soul: 1, profile: null, notes: "x", memoryTools: "y", coreFacts: "z" },
      })) as unknown as Record<string, unknown>), isAcp: true } as never,
      masterRegistry(),
    );
    expect(result.prompt).toContain("LEGACY-1869");
  });

  it("#1940: on the Pi route session-start carries hydration only, never the SOUL core", async () => {
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
    for (const marker of ["RECALL-1869", "WAKE-1869"]) {
      expect(prompt).toContain(marker);
    }
    for (const marker of ["PROFILE-1869", "NOTES-1869", "FACTS-1869", "SOUL-1869", "TOOLS-1869", "LEGACY-1869"]) {
      expect(prompt).not.toContain(marker);
    }
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

  it("re-injects the core parts without the history hydration that compaction just reduced (ACP)", async () => {
    const { runtime, assemble } = runtimeFor({
      coreKnowledge: "", recall: "RECALL-REHY", wakeUp: "WAKE-REHY",
      soulBundle: PARTS, parts: PARTS,
    });
    const session = rehydrateSession();
    const result = await buildPrompt(
      msg(), "hello",
      { ...(baseDeps(runtime) as unknown as Record<string, unknown>), isAcp: true } as never,
      masterRegistry(), session,
    );

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
    const result = await buildPrompt(
      msg(), "hello",
      { ...(baseDeps(runtime) as unknown as Record<string, unknown>), isAcp: true } as never,
      masterRegistry(), rehydrateSession(),
    );
    // Re-injecting here would duplicate what the legacy system prompt holds.
    expect(result.prompt).not.toContain("LEGACY-REHY");
  });

  it("#1940: on the Pi route there is no post-compaction rehydration — Pi owns compaction", async () => {
    const { runtime, assemble } = runtimeFor({
      coreKnowledge: "", recall: "RECALL-REHY", wakeUp: "WAKE-REHY",
      soulBundle: PARTS, parts: PARTS,
    });
    const session = rehydrateSession();
    const result = await buildPrompt(msg(), "hello", baseDeps(runtime), masterRegistry(), session);
    expect(result.isSessionStart).toBe(false);
    expect(result.prompt).not.toContain("PROFILE-REHY");
    expect(result.prompt).not.toContain("FACTS-REHY");
    expect(assemble).not.toHaveBeenCalled();
    expect((session as unknown as { pendingCoreRehydrate: boolean }).pendingCoreRehydrate).toBe(false);
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
