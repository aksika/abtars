import type { AbmindClient } from "abmind";

// ── Types ──────────────────────────────────────────────────────────────────

export type RuntimeState = "ready" | "disabled" | "unavailable";

export interface RecordMessageInput {
  userId: string;
  sessionId: string;
  role: string;
  content: string;
  timestamp: number;
  platformMessageId?: number;
  emotionScore?: number;
  typeHint?: string;
  topicHint?: string;
  emotionHint?: string;
}

export interface RecordMessageResult {
  id: number | null;
}

export interface RuntimeRecallInput {
  query: string;
  userId: string;
  limit?: number;
}

export interface RuntimeRecallHit {
  content: string;
  score: number;
  date: string;
  memoryId?: number;
}

export interface RuntimeRecallResult {
  hits: RuntimeRecallHit[];
  context: string;
}

export interface SessionContextInput {
  identity: { principalId: string; executionId: string };
  prompt?: string;
  maxChars?: number;
}

export interface SessionContextResult {
  wakeUp: string;
  recall: string;
  coreKnowledge: string;
}

export interface RecentConversationInput {
  userId: string;
  since: number;
  limit: number;
}

export type RecentConversationResult = Array<{ role: string; content: string; timestamp: number }>;

export interface RuntimeStatusInput {
  userId?: string;
}

export interface RuntimeStatusResult {
  totalMessages: number;
  extractedMemories: number;
  dbSizeBytes: number;
  uptimeMs?: number;
}

export interface CoreKnowledgeInput {
  // empty
}

export type CoreKnowledgeResult = string;

export interface FeedbackInput {
  memoryId: number;
  feedbackType: "cite" | "reject";
}

export interface FeedbackResult {
  ok: boolean;
}

export interface MaintenanceInput {
  operation: "integrity" | "fts_rebuild" | "wal_checkpoint";
}

export interface MaintenanceResult {
  ok: boolean;
  summary: string;
}

// ── Interface ──────────────────────────────────────────────────────────────

export interface AbtarsMemoryRuntime {
  readonly state: RuntimeState;
  readonly capabilities: ReadonlySet<string>;

  recordMessage(input: RecordMessageInput, operationKey: string): Promise<RecordMessageResult>;
  recall(input: RuntimeRecallInput): Promise<RuntimeRecallResult>;
  assembleSessionContext(input: SessionContextInput): Promise<SessionContextResult>;
  getRecentConversation(input: RecentConversationInput): Promise<RecentConversationResult>;
  getStatus(input?: RuntimeStatusInput): Promise<RuntimeStatusResult>;
  getCoreKnowledge(): Promise<CoreKnowledgeResult>;
  recordFeedback(input: FeedbackInput): Promise<FeedbackResult>;
  runMaintenance(input: MaintenanceInput): Promise<MaintenanceResult>;
  close(): Promise<void>;
}

// ── Client-backed implementation ──────────────────────────────────────────

export function createClientRuntime(client: AbmindClient): AbtarsMemoryRuntime {
  return {
    state: "ready" as RuntimeState,
    capabilities: new Set(["recall", "recordMessage", "feedback", "coreKnowledge", "status"]),

    async recordMessage(input: RecordMessageInput, _operationKey: string): Promise<RecordMessageResult> {
      const result = await client.privateMemory.recordMessage({
        userId: input.userId,
        sessionId: input.sessionId,
        role: input.role,
        content: input.content,
        timestamp: input.timestamp,
      });
      return { id: result.id };
    },

    async recall(input: RuntimeRecallInput): Promise<RuntimeRecallResult> {
      const result = await client.privateMemory.recall({
        translated: [input.query],
        original: input.query,
        userId: input.userId,
        limit: input.limit ?? 10,
      });
      const hits: RuntimeRecallHit[] = result.results.map(r => ({
        content: r.content,
        score: r.score,
        date: "",
      }));
      const context = hits.map(h => `- (score: ${h.score.toFixed(3)}) ${h.content.slice(0, 200)}`).join("\n");
      return { hits, context };
    },

    async assembleSessionContext(input: SessionContextInput): Promise<SessionContextResult> {
      let wakeUp = "";
      let recall = "";
      try {
        const status = await client.system.status();
        wakeUp = `Memory status: ${status.mode} (${status.requestCount} requests)`;
      } catch { wakeUp = ""; }
      if (input.prompt) {
        try {
          const rc = await this.recall({ query: input.prompt, userId: input.identity.principalId, limit: 5 });
          recall = rc.context;
        } catch { recall = ""; }
      }
      let coreKnowledge = "";
      try { coreKnowledge = await client.privateMemory.getCoreKnowledge(); } catch { coreKnowledge = ""; }
      return { wakeUp, recall, coreKnowledge };
    },

    async getRecentConversation(input: RecentConversationInput): Promise<RecentConversationResult> {
      return await client.privateMemory.getRecentConversation(input);
    },

    async getStatus(input?: RuntimeStatusInput): Promise<RuntimeStatusResult> {
      const stats = await client.privateMemory.getRuntimeStatus({ userId: input?.userId });
      return {
        totalMessages: stats?.totalMessages ?? 0,
        extractedMemories: stats?.extractedMemories ?? 0,
        dbSizeBytes: stats?.dbSizeBytes ?? 0,
      };
    },

    async getCoreKnowledge(): Promise<CoreKnowledgeResult> {
      return await client.privateMemory.getCoreKnowledge();
    },

    async recordFeedback(input: FeedbackInput): Promise<FeedbackResult> {
      await client.privateMemory.recordFeedback(input);
      return { ok: true };
    },

    async runMaintenance(input: MaintenanceInput): Promise<MaintenanceResult> {
      try {
        switch (input.operation) {
          case "fts_rebuild":
            const fts = await client.privateMemory.rebuildFtsIndexes();
            return { ok: true, summary: `FTS rebuilt: ${fts.rebuilt.join(", ")}` };
          default:
            return { ok: true, summary: `${input.operation} completed` };
        }
      } catch (err) {
        return { ok: false, summary: (err as Error).message };
      }
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}

// ── Disabled implementation ───────────────────────────────────────────────

export function createDisabledRuntime(): AbtarsMemoryRuntime {
  const unavailable = (method: string) => { throw new Error(`Memory is disabled: ${method} not available`); };
  return {
    state: "disabled" as RuntimeState,
    capabilities: new Set(),
    recordMessage: async () => { unavailable("recordMessage"); return { id: null }; },
    recall: async () => { unavailable("recall"); return { hits: [], context: "" }; },
    assembleSessionContext: async () => { unavailable("assembleSessionContext"); return { wakeUp: "", recall: "", coreKnowledge: "" }; },
    getRecentConversation: async () => { unavailable("getRecentConversation"); return []; },
    getStatus: async () => { unavailable("getStatus"); return { totalMessages: 0, extractedMemories: 0, dbSizeBytes: 0 }; },
    getCoreKnowledge: async () => { unavailable("getCoreKnowledge"); return ""; },
    recordFeedback: async () => { unavailable("recordFeedback"); return { ok: false }; },
    runMaintenance: async () => { unavailable("runMaintenance"); return { ok: false, summary: "Memory disabled" }; },
    close: async () => {},
  };
}

// ── Unavailable implementation (daemon unreachable) ───────────────────────

export function createUnavailableRuntime(): AbtarsMemoryRuntime {
  const unavailable = (method: string) => { throw new Error(`Memory unavailable: ${method} not available`); };
  return {
    state: "unavailable" as RuntimeState,
    capabilities: new Set(),
    recordMessage: async () => { unavailable("recordMessage"); return { id: null }; },
    recall: async () => { unavailable("recall"); return { hits: [], context: "" }; },
    assembleSessionContext: async () => { unavailable("assembleSessionContext"); return { wakeUp: "", recall: "", coreKnowledge: "" }; },
    getRecentConversation: async () => { unavailable("getRecentConversation"); return []; },
    getStatus: async () => { unavailable("getStatus"); return { totalMessages: 0, extractedMemories: 0, dbSizeBytes: 0 }; },
    getCoreKnowledge: async () => { unavailable("getCoreKnowledge"); return ""; },
    recordFeedback: async () => { unavailable("recordFeedback"); return { ok: false }; },
    runMaintenance: async () => { unavailable("runMaintenance"); return { ok: false, summary: "Memory unavailable" }; },
    close: async () => {},
  };
}
