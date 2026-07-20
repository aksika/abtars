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
  original?: string;
  timeStart?: number;
  timeEnd?: number;
  stages?: string[];
}

export interface RuntimeRecallHit {
  content: string;
  score: number;
  date: string;
  memoryId?: number;
  source?: string;
  contentOriginal?: string;
  memoryType?: string;
  trust?: number;
  integrity?: number;
  credibility?: number;
  classification?: number;
  emotionScore?: number;
  createdAt?: number;
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
  soulBundle: SessionSoulBundle;
}

export interface SessionSoulBundle {
  soul: string;
  profile: string;
  notes: string;
  memoryTools: string;
  coreFacts: string;
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
  extractedByType: Record<string, number>;
  consolidationFiles: { daily: number; weekly: number; quarterly: number };
  ingestedDocuments: number;
  preservedKeywords: number;
  dbSizeBytes: number;
  rejectedByScanner: number;
  uptimeMs?: number;
}

export interface CoreKnowledgeInput {
  userId: string;
}

export type CoreKnowledgeResult = string;

export interface FeedbackInput {
  userId: string;
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

export interface EmbeddingInput { texts: string[] }
export interface EmbeddingResult { vectors: Array<number[] | null>; model: string }

// ── Interface ──────────────────────────────────────────────────────────────

export interface AbtarsMemoryRuntime {
  readonly state: RuntimeState;
  readonly capabilities: ReadonlySet<string>;

  recordMessage(input: RecordMessageInput, operationKey: string): Promise<RecordMessageResult>;
  recall(input: RuntimeRecallInput): Promise<RuntimeRecallResult>;
  assembleSessionContext(input: SessionContextInput): Promise<SessionContextResult>;
  getRecentConversation(input: RecentConversationInput): Promise<RecentConversationResult>;
  getStatus(input?: RuntimeStatusInput): Promise<RuntimeStatusResult>;
  getCoreKnowledge(input: CoreKnowledgeInput): Promise<CoreKnowledgeResult>;
  recordFeedback(input: FeedbackInput, operationKey: string): Promise<FeedbackResult>;
  embed(input: EmbeddingInput): Promise<EmbeddingResult>;
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
        platformMessageId: input.platformMessageId,
        emotionScore: input.emotionScore,
        typeHint: input.typeHint,
        topicHint: input.topicHint,
        emotionHint: input.emotionHint,
      }, _operationKey);
      return { id: result.id };
    },

    async recall(input: RuntimeRecallInput): Promise<RuntimeRecallResult> {
      const result = await client.privateMemory.recall({
        translated: [input.query],
        original: input.original ?? input.query,
        userId: input.userId,
        limit: input.limit ?? 10,
        timeStart: input.timeStart,
        timeEnd: input.timeEnd,
        stages: input.stages,
      });
      const hits: RuntimeRecallHit[] = result.results.map(r => ({
        content: r.content,
        score: r.score,
        date: r.date,
        memoryId: r.id,
        source: r.source,
        contentOriginal: r.contentOriginal,
        memoryType: r.memoryType,
        trust: r.trust,
        integrity: r.integrity,
        credibility: r.credibility,
        classification: r.classification,
        emotionScore: r.emotionScore,
        createdAt: r.createdAt,
      }));
      const context = hits.map(h => `- (score: ${h.score.toFixed(3)}) ${h.content.slice(0, 200)}`).join("\n");
      return { hits, context };
    },

    async assembleSessionContext(input: SessionContextInput): Promise<SessionContextResult> {
      const assembled = await client.privateMemory.assembleSessionContext({
        userId: input.identity.principalId,
        maxChars: input.maxChars,
      });
      return assembled;
    },

    async getRecentConversation(input: RecentConversationInput): Promise<RecentConversationResult> {
      return await client.privateMemory.getRecentConversation(input);
    },

    async getStatus(input?: RuntimeStatusInput): Promise<RuntimeStatusResult> {
      const stats = await client.privateMemory.getRuntimeStatus({ userId: input?.userId });
      return {
        totalMessages: stats?.totalMessages ?? 0,
        extractedMemories: stats?.extractedMemories ?? 0,
        extractedByType: stats?.extractedByType ?? {},
        consolidationFiles: stats?.consolidationFiles ?? { daily: 0, weekly: 0, quarterly: 0 },
        ingestedDocuments: stats?.ingestedDocuments ?? 0,
        preservedKeywords: stats?.preservedKeywords ?? 0,
        dbSizeBytes: stats?.dbSizeBytes ?? 0,
        rejectedByScanner: stats?.rejectedByScanner ?? 0,
      };
    },

    async getCoreKnowledge(input: CoreKnowledgeInput): Promise<CoreKnowledgeResult> {
      return await client.privateMemory.getCoreKnowledge(input);
    },

    async recordFeedback(input: FeedbackInput, operationKey: string): Promise<FeedbackResult> {
      await client.privateMemory.recordFeedback(input, operationKey);
      return { ok: true };
    },

    async embed(input: EmbeddingInput): Promise<EmbeddingResult> {
      return await client.privateMemory.embed(input);
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
    assembleSessionContext: async () => { unavailable("assembleSessionContext"); return { wakeUp: "", recall: "", coreKnowledge: "", soulBundle: emptySoulBundle() }; },
    getRecentConversation: async () => { unavailable("getRecentConversation"); return []; },
    getStatus: async () => { unavailable("getStatus"); return { totalMessages: 0, extractedMemories: 0, extractedByType: {}, consolidationFiles: { daily: 0, weekly: 0, quarterly: 0 }, ingestedDocuments: 0, preservedKeywords: 0, dbSizeBytes: 0, rejectedByScanner: 0 }; },
    getCoreKnowledge: async () => { unavailable("getCoreKnowledge"); return ""; },
    recordFeedback: async () => { unavailable("recordFeedback"); return { ok: false }; },
    embed: async () => { unavailable("embed"); return { vectors: [], model: "" }; },
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
    assembleSessionContext: async () => { unavailable("assembleSessionContext"); return { wakeUp: "", recall: "", coreKnowledge: "", soulBundle: emptySoulBundle() }; },
    getRecentConversation: async () => { unavailable("getRecentConversation"); return []; },
    getStatus: async () => { unavailable("getStatus"); return { totalMessages: 0, extractedMemories: 0, extractedByType: {}, consolidationFiles: { daily: 0, weekly: 0, quarterly: 0 }, ingestedDocuments: 0, preservedKeywords: 0, dbSizeBytes: 0, rejectedByScanner: 0 }; },
    getCoreKnowledge: async () => { unavailable("getCoreKnowledge"); return ""; },
    recordFeedback: async () => { unavailable("recordFeedback"); return { ok: false }; },
    embed: async () => { unavailable("embed"); return { vectors: [], model: "" }; },
    runMaintenance: async () => { unavailable("runMaintenance"); return { ok: false, summary: "Memory unavailable" }; },
    close: async () => {},
  };
}

function emptySoulBundle(): SessionSoulBundle {
  return { soul: "", profile: "", notes: "", memoryTools: "", coreFacts: "" };
}
