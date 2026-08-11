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
