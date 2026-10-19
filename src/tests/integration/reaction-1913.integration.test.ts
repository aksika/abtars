/** #1913 composed answer reaction journey, owned-contract revision (#1928 M4).
 *
 * Real tool/pipeline/adapter/daemon composition; only chat/provider I/O is
 * scripted. The bridge recalls through the owned contract over a built
 * serving generation, declares support with source-safe C2 refs, and
 * reactions resolve through the same answer-evidence path as production.
 * Cite/reject feedback has no new-model landing surface yet (see backlog
 * #1936); this journey proves support tracking and marker hygiene, not
 * legacy cited_count bumps.
 */
import { describe, it, expect, vi } from "vitest";
import { AbmindService, type AbmindMethod, type AbmindRequestV1, type ServiceCallContext } from "abmind";
import { createHarness, memoryDb, type IntegrationHarness } from "./harness.js";
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
    pendingStart: false, seen: true, compactFailures: 0, ctxWarned: false, condensing: false, steeringAccepting: false };
}

const JOKE_EN = "Tuesday means Belgium as an inside joke";
const JOKE_ORIG = "Kedden Belgium a vicc szerint";

describe("#1913 composed answer reaction journey (owned refs)", () => {
  it("tool-only Hungarian answer reinforces its support once across two chunks and replay", async () => {
    const h = await createHarness();
    const db = memoryDb(h.memory);
    const active = session();
    const user = { userId: "u1", role: "master" as const, maxClass: 1, tools: ["all"], platforms: { telegram: 42 } };
    setUserRegistryOverride({ users: [user], byUserId: new Map([["u1", user]]), byPlatformId: new Map([["telegram:42", user]]) });
    const quota = new MemoryStoreQuota({ dbPath: `${h.tmpDir}/quota.db` });
    let adapter: TelegramAdapter | undefined;
    try {
      const stored = await h.memory.editor.instantStore({
        userId: "u1", contentEn: JOKE_EN, contentOriginal: JOKE_ORIG,
        memoryType: "fact", emotionScore: 0,
      });
      expect(stored.stored).toBe(true);
      const memId = stored.memoryId!;
      const { buildRecallProjection } = await import("abmind");
      expect(buildRecallProjection(db, "u1", { verifiedBackup: true }).ok).toBe(true);

      const service = new AbmindService({ serverInstanceId: "journey", mode: "embedded", manager: h.memory, operational: null, requestLedgerDb: db });
      const context: ServiceCallContext = { principalId: "u1", role: "local_user", grantedDomains: new Set(["private", "system"]), authenticatedBy: "embedded" };
      const call = async (method: AbmindMethod, payload: unknown, key?: string): Promise<unknown> => {
        const response = await service.handle({ version: 1, requestId: "journey", method, payload, idempotencyKey: key } as AbmindRequestV1, context);
        if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
        return response.result;
      };
      const ownedRecall = (profile: "recall_fast" | "recall_normal" | "recall_full", text: string) =>
        call("private.recall", {
          contract: "owned-v1", profile, identity: { principal: "u1" },
          ...(profile === "recall_fast" ? { rawTurn: text } : { query: { text } }),
          capacity: { maxItems: 10 },
        }) as Promise<{ items: Array<{ ref: { kind: string; layer?: string; recordId?: number; owner?: string }; excerpt: string }>; text: string; status: string }>;
      const runtime: AbtarsMemoryRuntime = {
        ...createDisabledRuntime(), state: "ready", capabilities: new Set(["recall", "recordMessage"]), supports: () => true,
        recall: async (input) => {
          const packet = await ownedRecall(input.profile, input.profile === "recall_fast" ? input.rawTurn ?? input.query : input.text ?? input.query);
          return {
            hits: packet.items.map((item) => ({
              ref: item.ref.kind === "db"
                ? `db:${item.ref.layer}:${item.ref.recordId}:${item.ref.owner}:${item.ref.version}`
                : `${item.ref.kind}:x`,
              kind: item.ref.kind === "db" || item.ref.kind === "artifact" || item.ref.kind === "graph" ? item.ref.kind : "db",
              content: item.excerpt,
              date: "",
            })),
            context: packet.text,
            status: packet.status,
          };
        },
        recordMessage: async () => ({ id: null }),
        recordFeedback: async () => ({ ok: true }),
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
        const read = await tool!.execute("read", { keywords: ["Belgium", "Tuesday"], profile: "recall_normal" });

        const refKey = `db:durable:${memId}:u1:1`;
        const innerText = (read as { content: Array<{ text: string }> }).content[0]!.text;
        const inner = JSON.parse(innerText) as { hits: Array<{ ref: string }> };
        expect(inner.hits[0]?.ref, "tool surfaces a source-safe ref").toBe(refKey);
        const declared = inner.hits[0]!.ref;
        active.activeExecutionId = undefined; // actual Spin releases before delivery
        return { sessionId: active.id, executionId: "journey-exec", result: `Kedden! [SUPPORT: ${declared}]`, outcome: "text" as const };
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
      const expectedRef = `db:durable:${memId}:u1:1`;

      expect(lookupAnswerRecord("telegram", "42", "501")?.support).toEqual([expectedRef]);
      expect(lookupAnswerRecord("telegram", "42", "502")?.support).toEqual([expectedRef]);
      for (const messageId of [501, 502, 501]) {
        const update: TelegramUpdate = { update_id: messageId, message_reaction: { chat: { id: 42, type: "private" }, user: { id: 42, first_name: "Tester", is_bot: false },
          message_id: messageId, date: 1, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }] } };
        await chat.update!(update);
      }
      // Support survives concurrent reactions across chunks (backlog #1936
      // tracks the missing new-model feedback landing surface).
      expect(lookupAnswerRecord("telegram", "42", "501")?.support).toEqual([`db:durable:${memId}:u1:1`]);
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
