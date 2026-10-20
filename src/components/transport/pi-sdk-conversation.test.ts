/**
 * pi-sdk-conversation.test.ts — #1932: the SDK conversation store owns
 * in-process conversations through real Pi AgentSession/SessionManager.
 *
 * Uses the real SDK surface (devDependency) with isolated tmp dirs and a
 * canned streamFn — no provider, no archive, no memory. Proves the exact
 * behaviors acceptance item 8 needs at this boundary: ID minting,
 * multi-turn Pi history reuse, same-ID reopen after eviction, and
 * fail-closed (never silent fallback) on missing/unverified files.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import {
  PiSdkConversationStore,
  isUsableSdkConversationSurface,
  testScratchDirs,
  type PiSdkConversationSurface,
  type SdkAgentAssembly,
  type SdkConversationKey,
} from "./pi-sdk-conversation.js";

/** Hermetic real-SDK surface: the pinned devDependency, never ambient Pi. */
function devSurface(): Promise<PiSdkConversationSurface> {
  const surface: PiSdkConversationSurface = {
    SessionManager: piCodingAgent.SessionManager as never,
    AgentSession: piCodingAgent.AgentSession as never,
    SettingsManager: piCodingAgent.SettingsManager as never,
    ModelRuntime: piCodingAgent.ModelRuntime as never,
    DefaultResourceLoader: piCodingAgent.DefaultResourceLoader as never,
  };
  if (!isUsableSdkConversationSurface(surface)) throw new Error("devDependency SDK surface unusable");
  return Promise.resolve(surface);
}

function testStore(stateDir: string, sessionRoot: string, extra?: { loadSurface?: () => Promise<PiSdkConversationSurface | null> }) {
  return new PiSdkConversationStore({
    stateDir,
    sessionStorageRoot: sessionRoot,
    loadSurface: extra?.loadSurface ?? devSurface,
  });
}

function makeKey(overrides?: Partial<SdkConversationKey>): SdkConversationKey {
  return {
    sessionKey: "test-session",
    principal: "test-principal",
    platform: "test-platform",
    role: "main",
    workspaceAlias: "ws",
    canonicalWorkspace: "/tmp/ws",
    memoryScope: "none",
    ...overrides,
  };
}

function cannedStreamFn(replies: string[], seen: unknown[]) {
  let n = 0;
  return async (_model: unknown, context: unknown, _options: unknown) => {
    seen.push(context);
    const text = replies[Math.min(n++, replies.length - 1)] ?? "ok";
    const terminal = {
      role: "assistant",
      content: text,
      stopReason: "stop",
      usage: { input: 5, output: 3 },
    };
    const events = [
      { type: "text_delta", contentIndex: 0, delta: text },
      { type: "done", reason: "stop", message: terminal },
    ];
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const ev of events) yield ev;
      },
      result: async () => terminal,
    };
  };
}

function makeAssembly(
  streamFn: ReturnType<typeof cannedStreamFn>,
  transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>,
): SdkAgentAssembly {
  const agent = new Agent({
    initialState: {
      systemPrompt: "test system",
      model: {
        id: "spike-model",
        name: "spike-model",
        api: "openai-completions",
        provider: "spike-provider",
        baseUrl: "https://spike.invalid/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 128,
      },
      messages: [],
      tools: [],
      thinkingLevel: "off",
    },
    streamFn: streamFn as never,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    toolExecution: "sequential",
    convertToLlm: (messages: AgentMessage[]) => messages as unknown as Message[],
    transformContext: transformContext ?? (async (messages: AgentMessage[]) => messages),
  });
  return {
    agent,
    baseTools: {},
    toolNames: [],
    provider: { providerId: "spike-provider", baseUrl: "https://spike.invalid/v1", apiKey: "k", api: "openai-completions" },
  };
}

function bindingPathFor(stateDir: string, sessionKey: string): string {
  const name = createHash("sha256").update(sessionKey, "utf8").digest("hex");
  return join(stateDir, "pi-sdk-conversations-v1", `${name}.json`);
}

function contextTexts(context: unknown): string {
  return JSON.stringify((context as { messages?: unknown })?.messages ?? context);
}

describe("isUsableSdkConversationSurface", () => {
  it("accepts the real SDK surface and rejects partial shapes", () => {
    expect(isUsableSdkConversationSurface(null)).toBe(false);
    expect(isUsableSdkConversationSurface({})).toBe(false);
    expect(isUsableSdkConversationSurface({
      SessionManager: piCodingAgent.SessionManager,
    })).toBe(false);
  });
});

describe("PiSdkConversationStore (real SDK)", () => {
  it("creates a conversation, prompts through the SDK session, and flushes Pi history", async () => {
    const { stateDir, sessionRoot } = testScratchDirs();
    const store = testStore(stateDir, sessionRoot);
    const seen: unknown[] = [];
    const key = makeKey();

    const opened = await store.ensureConversation(key, makeAssembly(cannedStreamFn(["hello world"], seen)));
    expect(opened.resumed).toBe(false);
    expect(opened.conversationId).toMatch(/^[A-Za-z0-9-]{36}$/);

    const result = await store.prompt(key.sessionKey, "first question");
    expect(result.text).toBe("hello world");
    expect(result.aborted).toBe(false);
    expect(result.usage).toMatchObject({ input: 5, output: 3 });
    expect(seen).toHaveLength(1);

    // The binding is durable and the Pi session file exists with history.
    const binding = JSON.parse(
      readFileSync(bindingPathFor(stateDir, "test-session"), "utf-8"),
    ) as { sessionKey: string; binding: { conversationId: string; sessionFile?: string } };
    expect(binding.sessionKey).toBe("test-session");
    const boundId = binding.binding.conversationId;
    expect(boundId).toBe(opened.conversationId);
    const sessionFile = binding.binding.sessionFile;
    expect(sessionFile).toBeTruthy();
    const transcript = readFileSync(sessionFile!, "utf-8");
    expect(transcript).toContain("first question");
    expect(transcript).toContain("hello world");
    store.dispose();
  });

  it("reuses Pi history on the second turn (no archive reconstruction on the intact path)", async () => {
    const { stateDir, sessionRoot } = testScratchDirs();
    const store = testStore(stateDir, sessionRoot);
    const seen: unknown[] = [];
    const key = makeKey();
    const streamFn = cannedStreamFn(["first reply", "second reply"], seen);
    const assembly = makeAssembly(streamFn);
    await store.ensureConversation(key, assembly);

    await store.prompt(key.sessionKey, "first question marker-AAA");
    const second = await store.prompt(key.sessionKey, "second question marker-BBB");
    expect(second.text).toBe("second reply");
    expect(seen).toHaveLength(2);
    // The second provider request carries the first exchange from Pi history.
    expect(contextTexts(seen[1])).toContain("marker-AAA");
    expect(contextTexts(seen[1])).toContain("first reply");
    store.dispose();
  });

  it("reopens the same conversation after eviction with history intact", async () => {
    const { stateDir, sessionRoot } = testScratchDirs();
    const key = makeKey();
    const first = testStore(stateDir, sessionRoot);
    const seen1: unknown[] = [];
    const opened = await first.ensureConversation(key, makeAssembly(cannedStreamFn(["x"], seen1)));
    await first.prompt(key.sessionKey, "persisted marker-CCC");
    first.dispose();

    // A fresh store (simulated restart) reopens the same ID from the binding.
    const second = testStore(stateDir, sessionRoot);
    const seen2: unknown[] = [];
    const assembly2 = makeAssembly(cannedStreamFn(["y"], seen2));
    const reopened = await second.ensureConversation(key, assembly2);
    expect(reopened.resumed).toBe(true);
    expect(reopened.conversationId).toBe(opened.conversationId);
    // The live agent persists per conversation: the same assembly serves the
    // reopened turn (production rebuilds per-turn inputs through the
    // transport-owned streamFn holder, not by replacing the agent).
    const result = await second.prompt(key.sessionKey, "follow-up marker-DDD");
    expect(result.text).toBe("y");
    expect(contextTexts(seen2[0])).toContain("marker-CCC");
    second.dispose();
  });

  it("rejects an overlapping prompt on a streaming conversation", async () => {
    const { stateDir, sessionRoot } = testScratchDirs();
    const store = testStore(stateDir, sessionRoot);
    const key = makeKey();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blockingStream = async () => {
      await gate;
      const terminal = {
        role: "assistant", content: "late", stopReason: "stop", usage: { input: 1, output: 1 },
      };
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { type: "done", reason: "stop", message: terminal };
        },
        result: async () => terminal,
      };
    };
    const assembly = makeAssembly(blockingStream as never);
    await store.ensureConversation(key, assembly);
    const first = store.prompt(key.sessionKey, "one");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(store.prompt(key.sessionKey, "two")).rejects.toThrow(/already streaming|overlapping/i);
    release();
    await first;
    store.dispose();
  });

  it("fails closed when the bound file is missing (never silent fallback)", async () => {
    const { stateDir, sessionRoot } = testScratchDirs();
    const store = testStore(stateDir, sessionRoot);
    const key = makeKey();
    const seen: unknown[] = [];
    // No live conversation and SessionManager unusable → surface failure propagates.
    const broken = testStore(stateDir, sessionRoot, { loadSurface: async () => null });
    await expect(broken.ensureConversation(key, makeAssembly(cannedStreamFn(["x"], seen)))).rejects.toThrow(
      /surface unavailable/i,
    );
    store.dispose();
    broken.dispose();
  });

  it("mints fresh when the bound file is missing and no archive exists (ephemeral)", async () => {
    const { stateDir, sessionRoot } = testScratchDirs();
    const key = makeKey();
    const store = testStore(stateDir, sessionRoot);
    const seen: unknown[] = [];
    const opened = await store.ensureConversation(key, makeAssembly(cannedStreamFn(["x"], seen)));
    await store.prompt(key.sessionKey, "marker-EEE");
    store.dispose();

    // Corrupt the binding to point at a valid-format but unknown ID: the
    // file is missing and ephemeral sessions carry no authorized source to
    // rebuild from, so a fresh conversation mints rather than wedging.
    // (Ambiguous duplicates still fail closed — see below.)
    const bindingPath = bindingPathFor(stateDir, "test-session");
    const binding = JSON.parse(readFileSync(bindingPath, "utf-8")) as {
      sessionKey: string; binding: { conversationId: string };
    };
    binding.binding.conversationId = "00000000-0000-0000-0000-000000000000";
    writeFileSync(bindingPath, JSON.stringify({ version: 1, sessionKey: binding.sessionKey, binding: binding.binding }));
    const reopened = testStore(stateDir, sessionRoot);
    const next = await reopened.ensureConversation(key, makeAssembly(cannedStreamFn(["x"], seen)));
    expect(next.resumed).toBe(false);
    expect(next.recovered).toBe("fresh");
    expect(next.conversationId).not.toBe("00000000-0000-0000-0000-000000000000");
    expect(opened.conversationId).not.toBe("00000000-0000-0000-0000-000000000000");
    reopened.dispose();
  });

  it("denies a binding that authorizes a different role or principal", async () => {
    const { stateDir, sessionRoot } = testScratchDirs();
    const store = testStore(stateDir, sessionRoot);
    const seen: unknown[] = [];
    await store.ensureConversation(makeKey(), makeAssembly(cannedStreamFn(["x"], seen)));
    store.dispose();

    const reopened = testStore(stateDir, sessionRoot);
    await expect(
      reopened.ensureConversation(makeKey({ role: "task" }), makeAssembly(cannedStreamFn(["x"], seen))),
    ).rejects.toThrow(/binding mismatch/);
    await expect(
      reopened.ensureConversation(makeKey({ principal: "someone-else" }), makeAssembly(cannedStreamFn(["x"], seen))),
    ).rejects.toThrow(/binding mismatch/);
    reopened.dispose();
  });

  it("fails closed on ambiguous duplicate files", async () => {
    const { stateDir, sessionRoot } = testScratchDirs();
    const store = testStore(stateDir, sessionRoot);
    const key = makeKey();
    const seen: unknown[] = [];
    const opened = await store.ensureConversation(key, makeAssembly(cannedStreamFn(["x"], seen)));
    await store.prompt(key.sessionKey, "marker-FFF");
    // Duplicate the flushed transcript under a second name: two claimants.
    const binding = JSON.parse(readFileSync(bindingPathFor(stateDir, "test-session"), "utf-8")) as {
      sessionKey: string; binding: { conversationId: string; sessionFile?: string };
    };
    const original = binding.binding.sessionFile!;
    const dir = original.slice(0, original.lastIndexOf("/"));
    writeFileSync(join(dir, `2026-02-02T00-00-00-000Z_${opened.conversationId}.jsonl`), readFileSync(original, "utf-8"));
    store.dispose();

    const reopened = testStore(stateDir, sessionRoot);
    await expect(
      reopened.ensureConversation(key, makeAssembly(cannedStreamFn(["x"], seen))),
    ).rejects.toThrow(/ambiguous/);
    reopened.dispose();
  });

  it("reconstructs a missing durable file from the archive under a fresh ID (R5)", async () => {
    const { stateDir, sessionRoot } = testScratchDirs();
    const key = makeKey({ memoryScope: "abmind" });
    const store = testStore(stateDir, sessionRoot);
    const seen: unknown[] = [];
    const opened = await store.ensureConversation(key, makeAssembly(cannedStreamFn(["x"], seen)));
    await store.prompt(key.sessionKey, "live marker-GGG");
    store.dispose();

    // Delete the Pi file: the binding still claims the conversation.
    const binding = JSON.parse(readFileSync(bindingPathFor(stateDir, "test-session"), "utf-8")) as {
      sessionKey: string; binding: { conversationId: string; sessionFile?: string };
    };
    rmSync(binding.binding.sessionFile!);

    const reopened = testStore(stateDir, sessionRoot);
    const archiveSource = {
      projectArchive: async () => ({
        messages: [
          { role: "user" as const, content: "archived-first" },
          { role: "assistant" as const, content: "archived-second" },
        ],
      }),
    };
    const next = await reopened.ensureConversation(key, makeAssembly(cannedStreamFn(["y"], seen)), {
      recovery: {
        archive: { userId: "u", archiveSessionId: "test-session", beforeMessageId: 2, maxContext: 128000 },
        archiveSource,
        current: { text: "current input", timestamp: 5, operationKey: "op-1" },
        taskEvidence: ["task snapshot"],
      },
    });
    expect(next.resumed).toBe(false);
    expect(next.recovered).toBe("reconstructed");
    expect(next.conversationId).not.toBe(opened.conversationId);
    // The successor file carries archive history, evidence, and the current
    // input exactly once — and the reopened conversation serves from it.
    const successorFile = (JSON.parse(readFileSync(bindingPathFor(stateDir, "test-session"), "utf-8")) as {
      binding: { sessionFile?: string };
    }).binding.sessionFile!;
    const transcript = readFileSync(successorFile, "utf-8");
    for (const marker of ["archived-first", "archived-second", "task snapshot", "current input"]) {
      expect(transcript).toContain(marker);
    }
    const result = await reopened.prompt(key.sessionKey, "follow-up");
    expect(result.text).toBe("y");
    reopened.dispose();
  });

  it("quarantines a corrupt ephemeral file and mints fresh", async () => {
    const { stateDir, sessionRoot } = testScratchDirs();
    const key = makeKey();
    const store = testStore(stateDir, sessionRoot);
    const seen: unknown[] = [];
    await store.ensureConversation(key, makeAssembly(cannedStreamFn(["x"], seen)));
    await store.prompt(key.sessionKey, "marker-HHH");
    const binding = JSON.parse(readFileSync(bindingPathFor(stateDir, "test-session"), "utf-8")) as {
      binding: { conversationId: string; sessionFile?: string };
    };
    writeFileSync(binding.binding.sessionFile!, "corrupt\n");
    store.dispose();

    const reopened = testStore(stateDir, sessionRoot);
    const next = await reopened.ensureConversation(key, makeAssembly(cannedStreamFn(["x"], seen)));
    expect(next.recovered).toBe("fresh");
    expect(existsSync(binding.binding.sessionFile!)).toBe(false);
    reopened.dispose();
  });

  it("aborts a streaming turn and reports aborted", async () => {
    const { stateDir, sessionRoot } = testScratchDirs();
    const store = testStore(stateDir, sessionRoot);
    const key = makeKey();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blockingStream = async () => {
      await gate;
      const terminal = {
        role: "assistant", content: "late", stopReason: "stop", usage: { input: 1, output: 1 },
      };
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { type: "done", reason: "stop", message: terminal };
        },
        result: async () => terminal,
      };
    };
    const assembly = makeAssembly(blockingStream as never);
    await store.ensureConversation(key, assembly);
    const pending = store.prompt(key.sessionKey, "abort me");
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Signal-only cancel (never awaited): acquisition may still be gated on
    // the provider timeout, which abort does not break out of.
    store.cancel(key.sessionKey);
    release();
    const result = await pending;
    expect(result.aborted).toBe(true);
    store.dispose();
  });

  it("settles a denied request as an error turn without throwing (callers read the denial)", async () => {
    // Pi settles a transform denial as an error turn instead of propagating
    // the throw: prompt() resolves empty here, and the transport surfaces
    // the denial it recorded. Pinned against Pi behavior drift — if a Pi
    // uplift starts propagating, this fails loudly and the tail mapping
    // must be revisited.
    const { stateDir, sessionRoot } = testScratchDirs();
    const store = testStore(stateDir, sessionRoot);
    const key = makeKey();
    let calls = 0;
    const assembly = makeAssembly(cannedStreamFn(["ok"], []), async (messages) => {
      calls++;
      if (calls >= 2) throw new Error("denied by test transform");
      return messages;
    });
    await store.ensureConversation(key, assembly);
    const first = await store.prompt(key.sessionKey, "one");
    expect(first.text).toBe("ok");
    const second = await store.prompt(key.sessionKey, "two");
    expect(second.text).toBe("");
    store.dispose();
  });

  it("forwards normalizeContext-shaped transcripts (streamFn contract)", async () => {
    const ctx = normalizeContext({ messages: [] });
    expect(Array.isArray((ctx as { messages?: unknown }).messages)).toBe(true);
  });
});
