import { describe, it, expect, vi } from "vitest";
import { buildPrompt } from "./prompt-builder.js";
import { createDisabledRuntime } from "../memory-runtime.js";
import * as logger from "../logger.js";

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


describe("buildPrompt inbound archive write (#1940 R1)", () => {
  const masterMsg = (id: string) => ({ userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: id } as never);

  it("records a master turn when memory is ready", async () => {
    const recordMessage = vi.fn().mockResolvedValue({ id: 42 });
    await buildPrompt(masterMsg("m1"), "hello", baseDeps(readyRuntime(recordMessage)), masterRegistry());
    expect(recordMessage).toHaveBeenCalledTimes(1);
  });

  it("a failed archive write never blocks the turn", async () => {
    const recordMessage = vi.fn().mockRejectedValue(new Error("owner down"));
    const result = await buildPrompt(masterMsg("m2"), "hello", baseDeps(readyRuntime(recordMessage)), masterRegistry());
    expect(result.prompt).toContain("hello");
    expect(recordMessage).toHaveBeenCalledTimes(1);
  });

  it("memory not ready: skipped inbound write is logged at WARN, nothing recorded (#1946 R2)", async () => {
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    try {
      const recordMessage = vi.fn().mockResolvedValue({ id: 1 });
      const notReady = { state: "unavailable" as const, capabilities: new Set<string>(), recordMessage } as never;
      const result = await buildPrompt(masterMsg("m4"), "hello", baseDeps(notReady), masterRegistry());
      expect(result.prompt).toContain("hello");
      expect(recordMessage).not.toHaveBeenCalled();
      const line = warnSpy.mock.calls.map((c) => String(c[1])).find((s) => s.includes("family=inbound"));
      expect(line).toBeDefined();
      expect(line).toContain("error=route_not_ready");
      expect(line).toMatch(/key=[0-9a-f]{12}\.\./);
      expect(line).not.toContain("hello");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("memory ready: no skip WARN is logged (#1946 R2)", async () => {
    const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    try {
      const recordMessage = vi.fn().mockResolvedValue({ id: 42 });
      await buildPrompt(masterMsg("m1b"), "hello", baseDeps(readyRuntime(recordMessage)), masterRegistry());
      expect(recordMessage).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls.some((c) => String(c[1]).includes("route_not_ready"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("guests, [SESSION START] and skill-isolated turns are not recorded", async () => {
    const recordMessage = vi.fn().mockResolvedValue({ id: 1 });
    await buildPrompt(
      { userId: "guest1", channelId: "1", platform: "telegram", isGroup: false, messageId: "m6" } as never,
      "hello", baseDeps(readyRuntime(recordMessage)),
      { byUserId: new Map([["guest1", { role: "guest" }]]) } as never,
    );
    await buildPrompt(masterMsg("m7"), "[SESSION START] You just came online.", baseDeps(readyRuntime(recordMessage)), masterRegistry());
    const kSession = { id: "master_K_1", userId: "master", platform: "telegram", chatId: 100, seen: true, pendingStart: false } as never;
    await buildPrompt(masterMsg("m8"), "hello", baseDeps(readyRuntime(recordMessage)), masterRegistry(), kSession);
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
      { ...(baseDeps(partsRuntime({
        coreKnowledge: "LEGACY-1869", recall: "RECALL-1869", wakeUp: "WAKE-1869",
        soulBundle: PARTS, parts: PARTS,
      })) as unknown as Record<string, unknown>), piRoute: true, piSessionLive: false } as never,
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

describe("#1940 — a new Pi session is a session start", () => {
  const seenSession = () => ({
    id: "master_A_1", userId: "master", platform: "telegram", chatId: 100, seen: true, pendingStart: false,
  } as never);
  const runtime = () => ({
    state: "ready",
    capabilities: new Set(["durableContext"]),
    recordMessage: vi.fn().mockResolvedValue({ id: 1 }),
    assembleSessionContext: vi.fn().mockResolvedValue({ coreKnowledge: "", recall: "RECALL-NEW", wakeUp: "WAKE-NEW" }),
  } as never);
  const msg = () => ({ userId: "master", channelId: "1", platform: "telegram", isGroup: false, messageId: "new-1" } as never);

  it("hydrates a seen session whose Pi session is gone (restart, rebuild, reset)", async () => {
    const result = await buildPrompt(
      msg(), "hello",
      { ...(baseDeps(runtime()) as unknown as Record<string, unknown>), piRoute: true, piSessionLive: false } as never,
      masterRegistry(), seenSession(),
    );
    expect(result.isSessionStart).toBe(true);
    expect(result.prompt).toContain("RECALL-NEW");
  });

  it("does not repeat hydration while the Pi session is live", async () => {
    const result = await buildPrompt(
      msg(), "hello",
      { ...(baseDeps(runtime()) as unknown as Record<string, unknown>), piRoute: true, piSessionLive: true } as never,
      masterRegistry(), seenSession(),
    );
    expect(result.isSessionStart).toBe(false);
    expect(result.prompt).not.toContain("RECALL-NEW");
  });
});
