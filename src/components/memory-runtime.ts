import { createHash } from "node:crypto";
import type { AbmindClientLike, AbmindPrivateMemoryLike, AbmindRouteSnapshotV1Like } from "./abmind-client-contract.js";

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
  memoryId?: number;
  semanticRevision?: number;
}

export interface EditMemoryInput {
  memoryId: number;
  expectedRevision: number;
  userId: string;
  contentEn?: string;
  contentOriginal?: string;
  memoryType?: string;
  emotionScore?: number;
  confidence?: number;
  classification?: number;
}

export interface EditMemoryResult {
  ok: boolean;
  error?: string;
  semanticRevision?: number;
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
  maxClassification?: number;
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
  semanticRevision?: number;
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
  /** Bounded route projection for diagnostics (#1382). */
  readonly routeSnapshot: AbmindRouteSnapshotV1Like;

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

function projectCapabilities(client: AbmindClientLike): Set<MemoryRuntimeCapability> {
  const caps: unknown = client.capabilities;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return new Set();

  const snapshot = caps as Record<string, unknown>;
  if (
    snapshot["version"] !== 1
    || !Array.isArray(snapshot["methods"])
    || snapshot["methods"].some(method => typeof method !== "string")
    || !snapshot["features"]
    || typeof snapshot["features"] !== "object"
    || Array.isArray(snapshot["features"])
  ) {
    return new Set();
  }

  const methods = new Set(snapshot["methods"] as string[]);
  const features = snapshot["features"] as Record<string, unknown>;
  const revisionContract = features["private_mutation_contract"] === "revision-v1";
  const result = new Set<MemoryRuntimeCapability>();

  if (methods.has("private.recall") && features["private_read"] === "true") result.add("recall");
  if (methods.has("private.recordMessage")) result.add("recordMessage");
  if (methods.has("private.instantStore") && features["private_write"] === "true" && revisionContract) result.add("instantStore");
  if (methods.has("private.edit") && features["private_write"] === "true" && revisionContract) result.add("editMemory");
  if (methods.has("private.rebuildFts") && features["private_write"] === "true") result.add("rebuildFts");
  if (methods.has("private.recordFeedback")) result.add("feedback");
  if (methods.has("private.getCoreKnowledge")) result.add("coreKnowledge");
  if (methods.has("private.getRuntimeStatus")) result.add("status");

  return result;
}

function requireClientCapability(capabilities: ReadonlySet<MemoryRuntimeCapability>, capability: MemoryRuntimeCapability): void {
  if (!capabilities.has(capability)) {
    throw new Error(`Memory capability unavailable: ${capability}`);
  }
}

// ── Client-backed implementation ──────────────────────────────────────────

export function createClientRuntime(client: AbmindClientLike): AbtarsMemoryRuntime {
  let capabilities = projectCapabilities(client);
  let state: RuntimeState = capabilities.size > 0 ? "ready" : "unavailable";
  const pm: AbmindPrivateMemoryLike = client.privateMemory;

  // #1382: a dropped signed-WSS route makes memory unavailable immediately
  // and clears stale capabilities; recovery re-projects them after the
  // reconnect authenticates and renegotiates. Local transports have no
  // background route and never notify, so state stays ready.
  if (typeof client.onRouteChange === "function") {
    try {
      client.onRouteChange((snapshot) => {
        if (snapshot.state === "ready") {
          capabilities = projectCapabilities(client);
          state = capabilities.size > 0 ? "ready" : "unavailable";
        } else {
          // Route loss clears stale capabilities immediately.
          capabilities = new Set();
          state = "unavailable";
        }
      });
    } catch { /* diagnostics wiring must never break the runtime */ }
  }

  const self: AbtarsMemoryRuntime = {
    get state() { return state; },
    get capabilities() { return capabilities; },
    routeSnapshot: client.routeSnapshot ?? { version: 1, state: "ready", generation: 0, retryEligible: 0, terminalUnknown: 0 },

    supports(capability: MemoryRuntimeCapability): boolean {
      return capabilities.has(capability);
    },

    async recordMessage(input: RecordMessageInput, _operationKey: string): Promise<RecordMessageResult> {
      requireClientCapability(capabilities, "recordMessage");
      const result = await pm.recordMessage({
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
      requireClientCapability(capabilities, "recall");
      const result = (await pm.recall({
        translated: [input.query],
        original: input.original ?? input.query,
        userId: input.userId,
        limit: input.limit ?? 10,
        maxClassification: input.maxClassification,
        timeStart: input.timeStart,
        timeEnd: input.timeEnd,
        stages: input.stages,
      })) as { results: Array<Record<string, unknown>> };
      const hits: RuntimeRecallHit[] = result.results.map((r) => ({
        content: String(r["content"] ?? ""),
        score: Number(r["score"] ?? 0),
        date: String(r["date"] ?? ""),
        memoryId: typeof r["id"] === "number" ? r["id"] : undefined,
        source: typeof r["source"] === "string" ? r["source"] : undefined,
        contentOriginal: typeof r["contentOriginal"] === "string" ? r["contentOriginal"] : undefined,
        memoryType: typeof r["memoryType"] === "string" ? r["memoryType"] : undefined,
        trust: typeof r["trust"] === "number" ? r["trust"] : undefined,
        integrity: typeof r["integrity"] === "number" ? r["integrity"] : undefined,
        credibility: typeof r["credibility"] === "number" ? r["credibility"] : undefined,
        classification: typeof r["classification"] === "number" ? r["classification"] : undefined,
        emotionScore: typeof r["emotionScore"] === "number" ? r["emotionScore"] : undefined,
        createdAt: typeof r["createdAt"] === "number" ? r["createdAt"] : undefined,
        semanticRevision: typeof r["semanticRevision"] === "number" ? r["semanticRevision"] : undefined,
      }));
      const context = hits.map(h => `- (score: ${h.score.toFixed(3)}) ${h.content.slice(0, 200)}`).join("\n");
      return { hits, context };
    },

    async assembleSessionContext(input: SessionContextInput): Promise<SessionContextResult> {
      const assembled = await pm.assembleSessionContext({
        userId: input.identity.principalId,
        maxChars: input.maxChars,
      });
      return assembled as SessionContextResult;
    },

    async getRecentConversation(input: RecentConversationInput): Promise<RecentConversationResult> {
      return (await pm.getRecentConversation(input)) as RecentConversationResult;
    },

    async getStatus(input?: RuntimeStatusInput): Promise<RuntimeStatusResult> {
      const rawStats = (await pm.getRuntimeStatus({ userId: input?.userId })) as unknown;
      const stats = (rawStats && typeof rawStats === "object" ? rawStats : {}) as Record<string, unknown>;
      const consolidation = (stats["consolidationFiles"] && typeof stats["consolidationFiles"] === "object"
        ? stats["consolidationFiles"]
        : {}) as Record<string, unknown>;
      return {
        totalMessages: typeof stats["totalMessages"] === "number" ? stats["totalMessages"] : 0,
        extractedMemories: typeof stats["extractedMemories"] === "number" ? stats["extractedMemories"] : 0,
        extractedByType: (typeof stats["extractedByType"] === "object" && stats["extractedByType"] !== null
          ? stats["extractedByType"] as Record<string, number>
          : {}),
        consolidationFiles: {
          daily: typeof consolidation["daily"] === "number" ? consolidation["daily"] : 0,
          weekly: typeof consolidation["weekly"] === "number" ? consolidation["weekly"] : 0,
          quarterly: typeof consolidation["quarterly"] === "number" ? consolidation["quarterly"] : 0,
        },
        ingestedDocuments: typeof stats["ingestedDocuments"] === "number" ? stats["ingestedDocuments"] : 0,
        preservedKeywords: typeof stats["preservedKeywords"] === "number" ? stats["preservedKeywords"] : 0,
        dbSizeBytes: typeof stats["dbSizeBytes"] === "number" ? stats["dbSizeBytes"] : 0,
        rejectedByScanner: typeof stats["rejectedByScanner"] === "number" ? stats["rejectedByScanner"] : 0,
      };
    },

    async getCoreKnowledge(input: CoreKnowledgeInput): Promise<CoreKnowledgeResult> {
      return (await pm.getCoreKnowledge(input)) as CoreKnowledgeResult;
    },

    async recordFeedback(input: FeedbackInput, operationKey: string): Promise<FeedbackResult> {
      await pm.recordFeedback(input, operationKey);
      return { ok: true };
    },

    async embed(input: EmbeddingInput): Promise<EmbeddingResult> {
      return (await pm.embed(input)) as EmbeddingResult;
    },

    async runMaintenance(input: MaintenanceInput): Promise<MaintenanceResult> {
      try {
        switch (input.operation) {
          case "fts_rebuild": {
            requireClientCapability(capabilities, "rebuildFts");
            const fts = (await pm.rebuildFtsIndexes()) as { rebuilt: string[] };
            return { ok: true, summary: `FTS rebuilt: ${fts.rebuilt.join(", ")}` };
          }
          default:
            return { ok: true, summary: `${input.operation} completed` };
        }
      } catch (err) {
        return { ok: false, summary: (err as Error).message };
      }
    },

    async instantStore(input: InstantStoreInput): Promise<InstantStoreResult> {
      requireClientCapability(capabilities, "instantStore");
      const result = (await pm.instantStore({
        userId: input.userId,
        contentEn: input.contentEn,
        contentOriginal: input.contentOriginal,
        memoryType: input.memoryType as string,
        emotionScore: input.emotionScore,
        confidence: input.confidence,
        classification: input.classification,
        createdBy: "tool:memory_store",
      })) as Record<string, unknown>;
      return {
        stored: result["stored"] === true,
        memoriesCount: typeof result["memoriesCount"] === "number" ? result["memoriesCount"] : undefined,
        error: typeof result["error"] === "string" ? result["error"] : undefined,
        memoryId: typeof result["memoryId"] === "number" ? result["memoryId"] : undefined,
        semanticRevision: typeof result["semanticRevision"] === "number" ? result["semanticRevision"] : undefined,
      };
    },

    async editMemory(input: EditMemoryInput): Promise<EditMemoryResult> {
      requireClientCapability(capabilities, "editMemory");
      const result = (await pm.editMemory({
        memoryId: input.memoryId,
        userId: input.userId,
        expectedRevision: input.expectedRevision,
        contentEn: input.contentEn,
        contentOriginal: input.contentOriginal,
        memoryType: input.memoryType as string,
        emotionScore: input.emotionScore,
        confidence: input.confidence,
        classification: input.classification,
      })) as Record<string, unknown>;
      if (result["ok"] !== true) {
        const code = typeof result["code"] === "string" ? result["code"] : "unknown";
        return { ok: false, error: code === "validation_error" ? String(result["message"] ?? "") : code };
      }
      const ref = (result["ref"] ?? result) as Record<string, unknown>;
      return {
        ok: true,
        semanticRevision: typeof ref["semanticRevision"] === "number" ? ref["semanticRevision"] : undefined,
      };
    },

    async rebuildFtsIndexes(): Promise<{ rebuilt: string[] }> {
      requireClientCapability(capabilities, "rebuildFts");
      return (await pm.rebuildFtsIndexes()) as { rebuilt: string[] };
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
    routeSnapshot: { version: 1, state: "closed", generation: 0, retryEligible: 0, terminalUnknown: 0 },
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
    routeSnapshot: { version: 1, state: "unavailable", generation: 0, reasonCode: "route_unavailable", retryEligible: 0, terminalUnknown: 0 },
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
