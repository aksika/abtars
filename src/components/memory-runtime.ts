import { createHash } from "node:crypto";
import type { AbmindClient } from "abmind";

import { logWarn } from "./logger.js";
import type { MemoryMutationFamily } from "./memory-operation-key.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type RuntimeState = "ready" | "disabled" | "unavailable";

export type MemoryRuntimeCapability =
  | "recall"
  | "recordMessage"
  | "instantStore"
  | "editMemory"
  | "rebuildFts"
  | "feedback"
  | "coreKnowledge"
  | "status";

export interface InstantStoreInput {
  userId: string;
  contentEn: string;
  contentOriginal: string;
  memoryType: string;
  emotionScore: number;
  confidence: number;
  classification: number;
}

export interface InstantStoreResult {
  stored: boolean;
  memoriesCount?: number;
  error?: string;
}

export interface EditMemoryInput {
  memoryId: number;
  contentEn?: string;
  contentOriginal?: string;
  memoryType?: string;
  emotionScore?: number;
  confidence?: number;
  classification?: number;
  caller?: string;
}

export interface EditMemoryResult {
  ok: boolean;
  error?: string;
}

export interface RecordMessageInput {
  userId: string;
  sessionId: string;
  role: string;
  content: string;
  timestamp: number;
  platformMessageId?: number | string;
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

/** Normalize an unknown recordMessage response to RecordMessageResult.
 *  Accepts canonical objects, legacy raw numbers, and null without throwing.
 *  Malformed values become { id: null } with a bounded warning. */
function normalizeRecordMessageResult(value: unknown): RecordMessageResult {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return { id: value };
  }
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as Record<string, unknown>).id;
    if (id === null) return { id: null };
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return { id };
  }
  if (value === null) {
    return { id: null };
  }
  logWarn("memory-runtime", "recordMessage: malformed non-null response, falling back to null");
  return { id: null };
}

// ── Interface ──────────────────────────────────────────────────────────────

export interface AbtarsMemoryRuntime {
  readonly state: RuntimeState;
  readonly capabilities: ReadonlySet<MemoryRuntimeCapability>;

  supports(capability: MemoryRuntimeCapability): boolean;
  recordMessage(input: RecordMessageInput, operationKey: string): Promise<RecordMessageResult>;
  recall(input: RuntimeRecallInput): Promise<RuntimeRecallResult>;
  assembleSessionContext(input: SessionContextInput): Promise<SessionContextResult>;
  getRecentConversation(input: RecentConversationInput): Promise<RecentConversationResult>;
  getStatus(input?: RuntimeStatusInput): Promise<RuntimeStatusResult>;
  getCoreKnowledge(input: CoreKnowledgeInput): Promise<CoreKnowledgeResult>;
  recordFeedback(input: FeedbackInput, operationKey: string): Promise<FeedbackResult>;
  embed(input: EmbeddingInput): Promise<EmbeddingResult>;
  runMaintenance(input: MaintenanceInput): Promise<MaintenanceResult>;
  instantStore(input: InstantStoreInput): Promise<InstantStoreResult>;
  editMemory(input: EditMemoryInput): Promise<EditMemoryResult>;
  rebuildFtsIndexes(): Promise<{ rebuilt: string[] }>;
  close(): Promise<void>;
}

// ── Capability projection ─────────────────────────────────────────────────

function projectCapabilities(client: AbmindClient): Set<MemoryRuntimeCapability> {
  const caps = client.capabilities;
  if (!caps) return new Set();
  const methods = new Set(caps.methods ?? []);
  const features = caps.features ?? {};
  const result = new Set<MemoryRuntimeCapability>();

  if (methods.has("private.recall")) result.add("recall");
  if (methods.has("private.recordMessage")) result.add("recordMessage");
  if (methods.has("private.instantStore") && features["private_write"] === "true") result.add("instantStore");
  if (methods.has("private.edit") && features["private_write"] === "true") result.add("editMemory");
  if (methods.has("private.rebuildFts") && features["private_write"] === "true") result.add("rebuildFts");
  if (methods.has("private.recordFeedback")) result.add("feedback");
  if (methods.has("private.getCoreKnowledge")) result.add("coreKnowledge");
  if (methods.has("private.getRuntimeStatus")) result.add("status");

  return result;
}

// ── Client-backed implementation ──────────────────────────────────────────

export function createClientRuntime(client: AbmindClient): AbtarsMemoryRuntime {
  const capabilities = projectCapabilities(client);

  const self: AbtarsMemoryRuntime = {
    state: "ready" as RuntimeState,
    capabilities,

    supports(capability: MemoryRuntimeCapability): boolean {
      return capabilities.has(capability);
    },

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
      return normalizeRecordMessageResult(result);
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
      const hits: RuntimeRecallHit[] = result.results.map((r: any) => ({
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

    async instantStore(input: InstantStoreInput): Promise<InstantStoreResult> {
      const result = await client.privateMemory.instantStore({
        userId: input.userId,
        contentEn: input.contentEn,
        contentOriginal: input.contentOriginal,
        memoryType: input.memoryType as any,
        emotionScore: input.emotionScore,
        confidence: input.confidence,
        classification: input.classification,
        createdBy: "tool:memory_store",
      });
      return {
        stored: result.stored,
        memoriesCount: result.memoriesCount,
        error: result.error,
      };
    },

    async editMemory(input: EditMemoryInput): Promise<EditMemoryResult> {
      const result = await client.privateMemory.editMemory({
        memoryId: input.memoryId,
        contentEn: input.contentEn,
        contentOriginal: input.contentOriginal,
        memoryType: input.memoryType as any,
        emotionScore: input.emotionScore,
        confidence: input.confidence,
        classification: input.classification,
        caller: input.caller ?? "kp",
      });
      return {
        ok: result.ok,
        error: result.error,
      };
    },

    async rebuildFtsIndexes(): Promise<{ rebuilt: string[] }> {
      return await client.privateMemory.rebuildFtsIndexes();
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
  return self;
}

// ── Disabled implementation ───────────────────────────────────────────────

export function createDisabledRuntime(): AbtarsMemoryRuntime {
  const unavailable = (method: string) => { throw new Error(`Memory is disabled: ${method} not available`); };
  return {
    state: "disabled" as RuntimeState,
    capabilities: new Set(),
    supports: () => false,
    recordMessage: async () => { unavailable("recordMessage"); return { id: null }; },
    recall: async () => { unavailable("recall"); return { hits: [], context: "" }; },
    assembleSessionContext: async () => { unavailable("assembleSessionContext"); return { wakeUp: "", recall: "", coreKnowledge: "", soulBundle: emptySoulBundle() }; },
    getRecentConversation: async () => { unavailable("getRecentConversation"); return []; },
    getStatus: async () => { unavailable("getStatus"); return { totalMessages: 0, extractedMemories: 0, extractedByType: {}, consolidationFiles: { daily: 0, weekly: 0, quarterly: 0 }, ingestedDocuments: 0, preservedKeywords: 0, dbSizeBytes: 0, rejectedByScanner: 0 }; },
    getCoreKnowledge: async () => { unavailable("getCoreKnowledge"); return ""; },
    recordFeedback: async () => { unavailable("recordFeedback"); return { ok: false }; },
    embed: async () => { unavailable("embed"); return { vectors: [], model: "" }; },
    runMaintenance: async () => { unavailable("runMaintenance"); return { ok: false, summary: "Memory disabled" }; },
    instantStore: async () => { unavailable("instantStore"); return { stored: false }; },
    editMemory: async () => { unavailable("editMemory"); return { ok: false }; },
    rebuildFtsIndexes: async () => { unavailable("rebuildFtsIndexes"); return { rebuilt: [] }; },
    close: async () => {},
  };
}

// ── Unavailable implementation (daemon unreachable) ───────────────────────

export function createUnavailableRuntime(): AbtarsMemoryRuntime {
  const unavailable = (method: string) => { throw new Error(`Memory unavailable: ${method} not available`); };
  return {
    state: "unavailable" as RuntimeState,
    capabilities: new Set(),
    supports: () => false,
    recordMessage: async () => { unavailable("recordMessage"); return { id: null }; },
    recall: async () => { unavailable("recall"); return { hits: [], context: "" }; },
    assembleSessionContext: async () => { unavailable("assembleSessionContext"); return { wakeUp: "", recall: "", coreKnowledge: "", soulBundle: emptySoulBundle() }; },
    getRecentConversation: async () => { unavailable("getRecentConversation"); return []; },
    getStatus: async () => { unavailable("getStatus"); return { totalMessages: 0, extractedMemories: 0, extractedByType: {}, consolidationFiles: { daily: 0, weekly: 0, quarterly: 0 }, ingestedDocuments: 0, preservedKeywords: 0, dbSizeBytes: 0, rejectedByScanner: 0 }; },
    getCoreKnowledge: async () => { unavailable("getCoreKnowledge"); return ""; },
    recordFeedback: async () => { unavailable("recordFeedback"); return { ok: false }; },
    embed: async () => { unavailable("embed"); return { vectors: [], model: "" }; },
    runMaintenance: async () => { unavailable("runMaintenance"); return { ok: false, summary: "Memory unavailable" }; },
    instantStore: async () => { unavailable("instantStore"); return { stored: false }; },
    editMemory: async () => { unavailable("editMemory"); return { ok: false }; },
    rebuildFtsIndexes: async () => { unavailable("rebuildFtsIndexes"); return { rebuilt: [] }; },
    close: async () => {},
  };
}

function emptySoulBundle(): SessionSoulBundle {
  return { soul: "", profile: "", notes: "", memoryTools: "", coreFacts: "" };
}

// ── Memory mutation isolation ─────────────────────────────────────────────

export type MemoryWritePhase = "before_model" | "after_delivery" | "feedback";

/**
 * Attempt a memory mutation with safe isolation: catches typed abmind errors,
 * logs one bounded diagnostic, and never retries.
 *
 * Callers map failure to undefined/no memory ID and continue. A failed memory
 * write does not disable the memory runtime or prevent model invocation.
 */
export async function attemptMemoryMutation<T>(input: {
  phase: MemoryWritePhase;
  family: MemoryMutationFamily;
  operationKey: string;
  run: () => Promise<T>;
}): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    const value = await input.run();
    return { ok: true, value };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "unknown";
    const keyFingerprint = createHash("sha256")
      .update(input.operationKey, "utf-8")
      .digest("hex")
      .slice(0, 12);
    logWarn(
      "memory-mutation",
      `phase=${input.phase} family=${input.family} error=${code} key=${keyFingerprint}..`,
    );
    return { ok: false };
  }
}
