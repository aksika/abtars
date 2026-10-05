/** #1913: real tool/pipeline/adapter/daemon composition; only chat/provider I/O is scripted. */
import { describe, it, expect, vi } from "vitest";
import { AbmindService, type AbmindMethod, type AbmindRequestV1, type ServiceCallContext } from "abmind";
import { createHarness, memoryDb } from "./harness.js";
import { createDisabledRuntime, type AbtarsMemoryRuntime } from "../../components/memory-runtime.js";
import { handleInboundMessage, type PipelineDeps } from "../../components/message-pipeline.js";
import { TelegramAdapter } from "../../platforms/telegram/telegram-adapter.js";
import type { TelegramUpdate } from "../../types/telegram.js";
import { setUserRegistryOverride } from "../../components/user-registry.js";
import { spin } from "../../components/spin.js";
import type { ManagedSession } from "../../components/spin-types.js";
import type { IKiroTransport } from "../../components/transport/kiro-transport.js";
import { createPiAgentTools } from "../../components/transport/pi-core-tools.js";
import { createPiExecutionSafetyController } from "../../components/transport/pi-core-safety.js";
import { FallbackPolicy } from "../../components/transport/fallback-policy.js";
import { ModelHealthRegistry } from "../../components/transport/model-health-registry.js";
import { buildPolicy } from "../../components/tool-sandbox.js";
import { MemoryStoreQuota } from "../../components/memory-store-quota.js";
import { lookupAnswerRecord } from "../../components/answer-evidence.js";

const chat = vi.hoisted(() => ({ send: vi.fn(), update: null as null | ((update: unknown) => Promise<void>) }));
vi.mock("../../platforms/telegram/telegram-api.js", () => ({ TelegramApi: class {
  getMe = async () => ({ username: "testbot" });
  setMyCommands = async () => {};
  sendMessage = chat.send;
  sendChatAction = async () => {};
  setMessageReaction = async () => {};
} }));
vi.mock("../../platforms/telegram/telegram-poller.js", () => ({ TelegramPoller: class {
  constructor(_api: unknown, _timeout: unknown, handler: (update: unknown) => Promise<void>) { chat.update = handler; }
  start(): void {}
  stop(): void {}
} }));

function session(): ManagedSession {
  return { id: "journey_A_01", userId: "u1", platform: "telegram", chatId: 42,
    delivery: "streaming", active: true, status: "ready", idleTimeoutMs: 0,
    lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
    log: [], shortIndex: 1, showThinking: false, busy: false, queue: [], fullMode: false,
    pendingStart: false, seen: true, compacting: false, ctxWarned: false, compactFailures: 0,
    primingTerms: [], completions: [], instructionQueue: [], steeringAccepting: false };
}

describe("#1913 composed answer reaction journey", () => {
  it("tool-only Hungarian answer reinforces its support once across two chunks and replay", async () => {
    const h = await createHarness();
    const db = memoryDb(h.memory);
    const active = session();
    const user = { userId: "u1", role: "master" as const, maxClass: 1, tools: ["all"], platforms: { telegram: 42 } };
    setUserRegistryOverride({ users: [user], byUserId: new Map([["u1", user]]), byPlatformId: new Map([["telegram:42", user]]) });
    const quota = new MemoryStoreQuota({ dbPath: `${h.tmpDir}/quota.db` });
    let adapter: TelegramAdapter | undefined;
    try {
      db.prepare("INSERT INTO extracted_memories (id,user_id,content_en,content_original,memory_type,source_timestamp,created_at,classification) VALUES (313,'u1','Tuesday means Belgium as an inside joke','Kedden Belgium a vicc szerint','fact',?,?,1)").run(Date.now(), Date.now());
      db.prepare("INSERT INTO extracted_memories (id,user_id,content_en,content_original,memory_type,source_timestamp,created_at,classification) VALUES (798,'u1','Unrelated recipe','Más recept','fact',?,?,1)").run(Date.now(), Date.now());
      const service = new AbmindService({ serverInstanceId: "journey", mode: "embedded", manager: h.memory, operational: null, requestLedgerDb: db });
      const context: ServiceCallContext = { principalId: "u1", role: "local_user", grantedDomains: new Set(["private", "system"]), authenticatedBy: "embedded" };
      const call = async (method: AbmindMethod, payload: unknown, key?: string): Promise<unknown> => {
        const response = await service.handle({ version: 1, requestId: "journey", method, payload, idempotencyKey: key } as AbmindRequestV1, context);
        if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
        return response.result;
      };
      const runtime: AbtarsMemoryRuntime = {
        ...createDisabledRuntime(), state: "ready", capabilities: new Set(["recall", "feedback"]), supports: () => true,
        recall: async (input) => {
          if (input.intent !== "explicit") return { hits: [], context: "" }; // tool-only fixture
          const result = await call("private.recall", { translated: input.keywords, userId: input.userId, intent: "explicit", limit: 10, stages: ["Sf", "Ss", "S6"] }) as Awaited<ReturnType<typeof h.recallSearch>>;
          return { hits: result.results.map((hit) => ({ memoryId: hit.id, content: hit.content, score: hit.score, date: hit.date })), context: "" };
        },
        recordMessage: async () => ({ id: null }),
        recordFeedback: async (input, key) => { await call("private.recordFeedback", input, key); return { ok: true }; },
      };
      const transport: IKiroTransport = { initialize: async () => {}, sendPrompt: async () => "", resetSession: async () => {},
        sendInterrupt: async () => {}, destroy: () => {}, transportCommands: [], isReady: true,
        contextPercent: -1, answerOnly: "", toolCallsSucceeded: 0, intermediateDeliveredText: "" };
      const buffer = { push: vi.fn(), drain: () => null, clear: () => {} };
      vi.spyOn(spin, "resolveSession").mockResolvedValue(active);
      vi.spyOn(spin, "getSessionById").mockReturnValue(active);
      vi.spyOn(spin, "getActiveSession").mockReturnValue(active);
      vi.spyOn(spin, "ensureSessionTransport").mockImplementation(async (entry) => { entry.transport = transport; });
      vi.spyOn(spin, "spin").mockImplementation(async () => ({ sessionId: active.id, result: "[NO_REPLY]", outcome: "no_reply" as const }));
      const provider = async () => {
        active.activeExecutionId = "journey-exec";
        const tools = createPiAgentTools({ executionId: "journey-exec", userId: "u1", sessionType: "A", sandboxPolicy: buildPolicy("owner", { allowedTools: ["memory_recall"] }),
          memoryToolDeps: { current: { runtime, quota } }, safety: createPiExecutionSafetyController(new FallbackPolicy([], new ModelHealthRegistry())) });
        const tool = tools.find((entry) => entry.name === "memory_recall");
        expect(tool).toBeDefined();
        expect(tool!.description).toContain("[SUPPORT:");
        const read = await tool!.execute("read", { keywords: ["Belgium", "Tuesday"] });
        expect(JSON.stringify(read)).toContain("313");
        active.activeExecutionId = undefined; // actual Spin releases before delivery
        return { sessionId: active.id, executionId: "journey-exec", result: "Kedden! [SUPPORT: 313]", outcome: "text" as const };
      };
      // This fixture scripts the provider/session ports; all ticket-owned internal paths are real.
      const deps = { transport, memoryRuntime: runtime, memoryConfig: { memoryEnabled: true, memoryDir: h.tmpDir },
        codingMode: { has: () => false, getTransport: () => null }, nlmConfig: { enabled: false },
        idleSave: { reset: () => {} }, conversationBuffer: buffer, config: { agentTransport: "pi", workingDir: h.tmpDir },
        startedAt: Date.now(), sttConfig: null, ttsConfig: null, updateCtxStart: () => {},
        sessionManager: { getActiveSessionId: () => active.id, getSessionById: () => active, getActiveSession: () => active, spin: provider },
      } as unknown as PipelineDeps;
      chat.send.mockResolvedValueOnce(501).mockResolvedValueOnce(502);
      adapter = new TelegramAdapter({ botToken: "fixture", allowedUserIds: new Set([42]), pollTimeoutS: 30 },
        { pipeline: deps, memoryRuntime: runtime, transport, conversationBuffer: deps.conversationBuffer, sessionManager: deps.sessionManager });
      await adapter.start();
      adapter.chunkResponse = () => ["Kedden!", "Belgium."];
      await handleInboundMessage({ platform: "telegram", channelId: "42", userId: "u1", senderId: "42", senderName: "Tester", text: "Which day?",
        timestamp: Date.now(), isGroup: false, isVoice: false }, adapter, deps);
      expect(lookupAnswerRecord("telegram", "42", "501")?.support).toEqual([313]);
      expect(lookupAnswerRecord("telegram", "42", "502")?.support).toEqual([313]);
      for (const messageId of [501, 502, 501]) {
        const update: TelegramUpdate = { update_id: messageId, message_reaction: { chat: { id: 42, type: "private" }, user: { id: 42, first_name: "Tester", is_bot: false },
          message_id: messageId, date: 1, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }] } };
        await chat.update!(update);
        // Simulate a daemon reconnect after completed receipt pruning. The
        // still-live answer must retain its explicit reaction outcome.
        db.prepare("DELETE FROM abmind_service_requests WHERE state = 'completed'").run();
      }
      expect(db.prepare("SELECT id,cited_count FROM extracted_memories ORDER BY id").all()).toEqual([{ id: 313, cited_count: 2 }, { id: 798, cited_count: 0 }]);
      expect(chat.send.mock.calls.map((args) => args[1]).join(" ")).not.toContain("SUPPORT");
    } finally {
      await adapter?.stop();
      quota.close();
      vi.restoreAllMocks();
      setUserRegistryOverride(null);
      h.cleanup();
    }
  });
});

/*
 * TEST DEFICIENCY (2026-10-05):
 * Missing: real-model support metadata compliance and embedding-enabled incident reproduction.
 * Reason deferred: this local composition replaces provider I/O and has no live recall histories.
 * Future verification: one fresh model attribution probe and a saved embedding-enabled incident fixture.
 */
