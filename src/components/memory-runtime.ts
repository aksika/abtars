import { createHash } from "node:crypto";
import type {
  AbmindClientLike,
  AbmindClientErrorLike,
  AbmindPrivateMemoryLike,
  AbmindRouteSnapshotV1Like,
  SleepStatusLike,
} from "./abmind-client-contract.js";

import { logWarn, redactSecrets } from "./logger.js";
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
  | "status"
  | "durableContext"
  | "compaction"
  | "dreamQuestions"
  | "dreamQuestionsNextPending";

export interface InstantStoreInput {
  userId: string;
  contentEn: string;
  contentOriginal: string;
  memoryType: string;
  emotionScore: number;
  confidence: number;
  classification: number;
}

/**
 * #1659: normalized structural mutation failure shared by store and edit
 * paths. Fields are preserved from the protocol contract; the bridge code
 * keeps its own stable `memory_*` classification.
 */
export interface MemoryMutationFailureFields {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly action: "fix_input" | "re_recall" | "retry" | "reconcile" | "stop";
  readonly stage: "pre_dispatch" | "dispatch" | "response";
}

const MEMORY_FAILURE_MESSAGE_MAX = 512;
const MEMORY_FAILURE_CODE_MAX = 64;
const MEMORY_FAILURE_REQUEST_ID_MAX = 128;

function boundedFailureText(value: unknown, max: number): string {
  const raw = value instanceof Error
    ? value.message
    : value && typeof value === "object" && "message" in value && typeof (value as { message?: unknown }).message === "string"
      ? (value as { message: string }).message
      : String(value);
  const redacted = redactSecrets(raw);
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 3)}...`;
}

function boundedFailureMessage(value: unknown): string {
  return boundedFailureText(value, MEMORY_FAILURE_MESSAGE_MAX);
}

export type InstantStoreResult =
  | {
      readonly stored: true;
      readonly memoriesCount: number;
      readonly memoryId: number;
      readonly semanticRevision: number;
    }
  | ({ readonly stored: false; readonly memoriesCount: 0 } & MemoryMutationFailureFields);

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

export type EditMemoryResult =
  | { readonly ok: true; readonly semanticRevision?: number }
  | ({ readonly ok: false } & MemoryMutationFailureFields);

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

// ── #1527: durable context projection ────────────────────────────────────────

export interface DurableContextProjectionInput {
  userId: string;
  sessionId: string;
  beforeMessageId: number;
  maxContext: number;
}

export interface DurableContextProjectionResult {
  messages: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
  estimatedTokens: number;
  sourceMessageCount: number;
}

/**
 * Read-only provider contract consumed by Pi durable projection. The runtime
 * supplies an adapter; disabled/unavailable runtimes reject instead of
 * returning an empty successful projection.
 */
export interface DurableContextProvider {
  projectContext(input: DurableContextProjectionInput): Promise<DurableContextProjectionResult>;
}

// ── #1406: durable conversation compaction ───────────────────────────────────

export interface CompactionCandidateLike {
  version: 1;
  expectedGeneration: number;
  previousCheckpointId: number | null;
  sourceMessageStart: number;
  sourceMessageEnd: number;
  firstKeptMessageId: number;
  sourceDigest: string;
  sourceTokenCount: number;
  serializedTurns: string;
  priorCheckpoint: string;
  summaryTokenBudget: number;
}

export interface PrepareConversationCompactionInput {
  userId: string;
  sessionId: string;
  beforeMessageId?: number;
  maxHistoryTokens: number;
  minRecentTokens: number;
  reason: "manual" | "automatic";
}

export type PrepareConversationCompactionResult =
  | { status: "nothing_to_compact" }
  | { status: "busy" }
  | { status: "ready"; candidate: CompactionCandidateLike };

export interface CommitConversationCompactionInput {
  userId: string;
  sessionId: string;
  candidate: Omit<CompactionCandidateLike, "serializedTurns" | "priorCheckpoint" | "summaryTokenBudget">;
  summary: string;
  summaryTokenCount: number;
  summarizer: { provider: string | null; model: string | null };
  activeRequestModel: string | null;
  reason: "manual" | "automatic";
  customInstructionsDigest?: string;
}

export type CommitConversationCompactionResult =
  | { status: "committed"; checkpointId: number; generation: number }
  | { status: "stale" }
  | { status: "rejected" };

// ── #1515: durable Dreamy clarification questions ─────────────────────────────

export interface DreamQuestionWireLike {
  id: string;
  memoryAId: number;
  memoryBId: number;
  question: string;
  status: "pending" | "asked" | "resolved" | "expired" | "dismissed";
  createdAt: number;
  expiresAt: number;
  askedAt?: number;
}

export type DreamQuestionStatusLike = "pending" | "asked" | "resolved" | "expired" | "dismissed";

const PROJECTION_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "tool"]);

// ── #1659: structural failure normalization ─────────────────────────────────

/** Stable bridge-side code for the protocol failure table. */
function bridgeFailureCode(code: string): string {
  switch (code) {
    case "validation_error": return "memory_validation";
    case "not_found": return "memory_not_found";
    case "conflict": return "memory_conflict";
    case "unauthorized": return "memory_unauthorized";
    case "idempotency_conflict": return "memory_idempotency_conflict";
    case "unavailable": return "memory_unavailable";
    case "outcome_unknown": return "memory_outcome_unknown";
    default: return code;
  }
}

/** Normalize a thrown structural client error into the shared failure fields. */
function failureFields(err: unknown): MemoryMutationFailureFields {
  const e = err as Partial<AbmindClientErrorLike> | null | undefined;
  const code = e && typeof e.code === "string" ? boundedFailureText(e.code, MEMORY_FAILURE_CODE_MAX) : "unknown";
  const hasStructuralStage = e && (e.stage === "pre_dispatch" || e.stage === "dispatch" || e.stage === "response");
  return {
    code: bridgeFailureCode(code),
    message: boundedFailureMessage(err),
    requestId: e && typeof e.requestId === "string" ? boundedFailureText(e.requestId, MEMORY_FAILURE_REQUEST_ID_MAX) : "",
    retryable: e && typeof e.retryable === "boolean" ? e.retryable : false,
    action: e && (e.action === "fix_input" || e.action === "re_recall" || e.action === "retry" || e.action === "reconcile" || e.action === "stop")
      ? e.action
      : "reconcile",
    // Unstructured errors provide no dispatch evidence: treat the outcome as
    // uncertain (response), never as a proven pre-dispatch refusal.
    stage: hasStructuralStage
      ? (e!.stage as MemoryMutationFailureFields["stage"])
      : "response",
  };
}

/** True when a structured failure proves the mutation definitely did not begin. */
export function isDefinitivePreDispatchFailure(code: string, stage: string): boolean {
  if (stage === "pre_dispatch") return true;
  return code === "memory_not_found" || code === "memory_conflict" || code === "memory_validation"
    || code === "memory_unauthorized" || code === "memory_idempotency_conflict";
}

function normalizeProjectionResult(value: unknown): DurableContextProjectionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Durable context projection returned a non-object response");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record["messages"])) {
    throw new Error("Durable context projection response has no messages array");
  }
  const messages: Array<{ role: "user" | "assistant" | "tool"; content: string }> = [];
  for (const raw of record["messages"] as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Durable context projection returned a malformed message");
    }
    const m = raw as Record<string, unknown>;
    if (typeof m["role"] !== "string" || !PROJECTION_ROLES.has(m["role"]) || typeof m["content"] !== "string") {
      throw new Error("Durable context projection returned a malformed message");
    }
    messages.push({ role: m["role"] as "user" | "assistant" | "tool", content: m["content"] });
  }
  const estimatedTokens = typeof record["estimatedTokens"] === "number" ? record["estimatedTokens"] : 0;
  const sourceMessageCount = typeof record["sourceMessageCount"] === "number" ? record["sourceMessageCount"] : 0;
  return { messages, estimatedTokens, sourceMessageCount };
}

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
  /** Read daemon-owned sleep lifecycle state for operator status commands. */
  getSleepStatus(): Promise<SleepStatusLike>;
  getCoreKnowledge(input: CoreKnowledgeInput): Promise<CoreKnowledgeResult>;
  recordFeedback(input: FeedbackInput, operationKey: string): Promise<FeedbackResult>;
  embed(input: EmbeddingInput): Promise<EmbeddingResult>;
  runMaintenance(input: MaintenanceInput): Promise<MaintenanceResult>;
  instantStore(input: InstantStoreInput): Promise<InstantStoreResult>;
  editMemory(input: EditMemoryInput): Promise<EditMemoryResult>;
  rebuildFtsIndexes(): Promise<{ rebuilt: string[] }>;
  /** #1527: daemon-owned durable context projection. Rejects when unavailable. */
  projectDurableContext(input: DurableContextProjectionInput): Promise<DurableContextProjectionResult>;
  /** #1406: daemon-owned durable compaction prepare (bounded read). */
  prepareConversationCompaction(input: PrepareConversationCompactionInput): Promise<PrepareConversationCompactionResult>;
  /** #1406: daemon-owned durable compaction commit (generation CAS). */
  commitConversationCompaction(input: CommitConversationCompactionInput, operationKey: string): Promise<CommitConversationCompactionResult>;
  /** #1515: optional owner-scoped dream-question lifecycle. Presence of the
   *  `dreamQuestions` capability is checked independently of core recall. */
  dreamQuestions: {
    nextPending(userId: string): Promise<DreamQuestionWireLike | null>;
    list(userId: string, status?: DreamQuestionStatusLike, limit?: number): Promise<{ questions: DreamQuestionWireLike[] }>;
    markAsked(userId: string, questionId: string, deliveryKey: string): Promise<{ status: "asked" | "not_found" | "conflict" }>;
    dismiss(userId: string, questionId: string): Promise<{ status: "dismissed" | "not_found" | "already_terminal" }>;
  };
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
  if (methods.has("private.projectConversationContext") && features["private_read"] === "true") result.add("durableContext");
  if (methods.has("private.prepareConversationCompaction")
    && methods.has("private.commitConversationCompaction")
    && features["private_write"] === "true") result.add("compaction");
  if (methods.has("private.dreamQuestions.nextPending")) result.add("dreamQuestionsNextPending");
  if (methods.has("private.dreamQuestions.nextPending")
    && methods.has("private.dreamQuestions.list")
    && methods.has("private.dreamQuestions.markAsked")
    && methods.has("private.dreamQuestions.dismiss")) result.add("dreamQuestions");

  return result;
}

function requireClientCapability(capabilities: ReadonlySet<MemoryRuntimeCapability>, capability: MemoryRuntimeCapability): void {
  if (!capabilities.has(capability)) {
    throw new Error(`Memory capability unavailable: ${capability}`);
  }
}

const DREAM_QUESTION_IDEMPOTENCY_KEY_MAX = 128;

/** Keep normal keys readable, but never let caller-controlled bounded fields
 * exceed abmind's idempotency-key limit. The hash retains the full tuple so
 * oversized IDs cannot collide merely because they share a prefix. */
function dreamQuestionIdempotencyKey(kind: "ask" | "dismiss", questionId: string, deliveryKey?: string): string {
  const raw = deliveryKey === undefined
    ? `dream-question-${kind}-${questionId}`
    : `dream-question-${kind}-${questionId}-${deliveryKey}`;
  if (raw.length <= DREAM_QUESTION_IDEMPOTENCY_KEY_MAX) return raw;
  const digest = createHash("sha256")
    .update(JSON.stringify([kind, questionId, deliveryKey ?? ""]), "utf-8")
    .digest("hex");
  return `dream-question-${kind}-v1-${digest}`;
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

    async getSleepStatus(): Promise<SleepStatusLike> {
      return await client.sleep.status();
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
      try {
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
          stored: true,
          memoriesCount: typeof result["memoriesCount"] === "number" ? result["memoriesCount"] : 1,
          memoryId: typeof result["memoryId"] === "number" ? result["memoryId"] : 0,
          semanticRevision: typeof result["semanticRevision"] === "number" ? result["semanticRevision"] : 1,
        };
      } catch (err) {
        // #1659: never flatten a protocol failure back to a bare string.
        return { stored: false, memoriesCount: 0, ...failureFields(err) };
      }
    },

    async editMemory(input: EditMemoryInput): Promise<EditMemoryResult> {
      requireClientCapability(capabilities, "editMemory");
      try {
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
        const ref = (result["ref"] ?? result) as Record<string, unknown>;
        return {
          ok: true,
          semanticRevision: typeof ref["semanticRevision"] === "number" ? ref["semanticRevision"] : undefined,
        };
      } catch (err) {
        return { ok: false, ...failureFields(err) };
      }
    },

    async rebuildFtsIndexes(): Promise<{ rebuilt: string[] }> {
      requireClientCapability(capabilities, "rebuildFts");
      return (await pm.rebuildFtsIndexes()) as { rebuilt: string[] };
    },

    async projectDurableContext(input: DurableContextProjectionInput): Promise<DurableContextProjectionResult> {
      // #1527: route loss clears capabilities immediately; recovery re-projects
      // them after renegotiation. Every call checks the current route state.
      requireClientCapability(capabilities, "durableContext");
      try {
        const result = await pm.projectConversationContext(input);
        return normalizeProjectionResult(result);
      } catch (err) {
        // Bounded, content-free diagnostic: route state + protocol reason code.
        const code = err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : "unknown";
        const route = client.routeSnapshot?.state ?? "unknown";
        logWarn("memory-runtime", `durable_projection_failed route=${route} reason=${code}`);
        throw err;
      }
    },

    async prepareConversationCompaction(input: PrepareConversationCompactionInput): Promise<PrepareConversationCompactionResult> {
      requireClientCapability(capabilities, "compaction");
      const result = await pm.prepareConversationCompaction(input) as unknown;
      return normalizePrepareResult(result);
    },

    async commitConversationCompaction(input: CommitConversationCompactionInput, operationKey: string): Promise<CommitConversationCompactionResult> {
      requireClientCapability(capabilities, "compaction");
      const result = await pm.commitConversationCompaction(input, operationKey) as unknown;
      return normalizeCommitResult(result);
    },

    dreamQuestions: {
      async nextPending(userId: string): Promise<DreamQuestionWireLike | null> {
        requireClientCapability(capabilities, "dreamQuestionsNextPending");
        const result = await pm.dreamQuestions.nextPending(userId) as unknown;
        if (result === null || result === undefined) return null;
        const pending = normalizeDreamQuestion(result);
        if (pending.status !== "pending") throw new Error("Dream question nextPending returned a non-pending row");
        return pending;
      },
      async list(userId: string, status?: DreamQuestionStatusLike, limit?: number): Promise<{ questions: DreamQuestionWireLike[] }> {
        requireClientCapability(capabilities, "dreamQuestions");
        const result = await pm.dreamQuestions.list(userId, status, limit) as unknown;
        return normalizeDreamQuestionList(result);
      },
      async markAsked(userId: string, questionId: string, deliveryKey: string): Promise<{ status: "asked" | "not_found" | "conflict" }> {
        requireClientCapability(capabilities, "dreamQuestions");
        // Stable idempotency key derived from question id + delivery key — a
        // retry after a crash replays the same CAS instead of double-marking.
        const result = await pm.dreamQuestions.markAsked(
          { userId, questionId, deliveryKey },
          dreamQuestionIdempotencyKey("ask", questionId, deliveryKey),
        ) as unknown;
        return normalizeMarkAskedResult(result);
      },
      async dismiss(userId: string, questionId: string): Promise<{ status: "dismissed" | "not_found" | "already_terminal" }> {
        requireClientCapability(capabilities, "dreamQuestions");
        const result = await pm.dreamQuestions.dismiss({ userId, questionId }, dreamQuestionIdempotencyKey("dismiss", questionId)) as unknown;
        return normalizeDismissResult(result);
      },
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
  return self;
}

const COMPACTION_CANDIDATE_MAX_BYTES = 240_000;
const COMPACTION_BUDGET_MIN_TOKENS = 2_000;
const COMPACTION_BUDGET_MAX_TOKENS = 12_000;

function safeInteger(value: unknown, field: string, opts: { min: number; max?: number }): number {
  if (!Number.isSafeInteger(value) || (value as number) < opts.min || (opts.max !== undefined && (value as number) > opts.max)) {
    throw new Error(`Compaction response field ${field} is malformed`);
  }
  return value as number;
}

/** Normalize an unknown prepare response. Every candidate proof field is
 * required and bounded; malformed values must fail closed, never become a
 * fake ready candidate through defaults. */
function normalizePrepareResult(value: unknown): PrepareConversationCompactionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Compaction prepare returned a non-object response");
  }
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (status === "nothing_to_compact") return { status: "nothing_to_compact" };
  if (status === "busy") return { status: "busy" };
  if (status === "ready") {
    const c = record["candidate"] as Record<string, unknown> | null | undefined;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("Compaction prepare candidate malformed");
    if (typeof c["serializedTurns"] !== "string") throw new Error("Compaction prepare candidate has no serialized source");
    if (Buffer.byteLength(c["serializedTurns"], "utf-8") > COMPACTION_CANDIDATE_MAX_BYTES) {
      throw new Error("Compaction prepare candidate source is too large");
    }
    if (c["version"] !== 1) throw new Error("Compaction prepare candidate version is unsupported");
    const expectedGeneration = safeInteger(c["expectedGeneration"], "expectedGeneration", { min: 0 });
    const previousCheckpointId = c["previousCheckpointId"] === null
      ? null
      : safeInteger(c["previousCheckpointId"], "previousCheckpointId", { min: 1 });
    const sourceMessageStart = safeInteger(c["sourceMessageStart"], "sourceMessageStart", { min: 1 });
    const sourceMessageEnd = safeInteger(c["sourceMessageEnd"], "sourceMessageEnd", { min: sourceMessageStart });
    const firstKeptMessageId = safeInteger(c["firstKeptMessageId"], "firstKeptMessageId", { min: sourceMessageEnd + 1 });
    if (typeof c["sourceDigest"] !== "string" || !/^[0-9a-f]{16}$/.test(c["sourceDigest"])) {
      throw new Error("Compaction prepare candidate digest is malformed");
    }
    const sourceTokenCount = safeInteger(c["sourceTokenCount"], "sourceTokenCount", { min: 1 });
    if (sourceTokenCount !== Math.ceil(c["serializedTurns"].length / 4)) {
      throw new Error("Compaction prepare candidate token estimate is inconsistent");
    }
    const sourceDigest = createHash("sha256").update(c["serializedTurns"], "utf-8").digest("hex").slice(0, 16);
    if (sourceDigest !== c["sourceDigest"]) throw new Error("Compaction prepare candidate digest is inconsistent");
    if (typeof c["priorCheckpoint"] !== "string") throw new Error("Compaction prepare prior checkpoint is malformed");
    const summaryTokenBudget = safeInteger(c["summaryTokenBudget"], "summaryTokenBudget", {
      min: COMPACTION_BUDGET_MIN_TOKENS,
      max: COMPACTION_BUDGET_MAX_TOKENS,
    });
    return {
      status: "ready",
      candidate: {
        version: 1,
        expectedGeneration,
        previousCheckpointId,
        sourceMessageStart,
        sourceMessageEnd,
        firstKeptMessageId,
        sourceDigest,
        sourceTokenCount,
        serializedTurns: c["serializedTurns"],
        priorCheckpoint: c["priorCheckpoint"],
        summaryTokenBudget,
      },
    };
  }
  throw new Error(`Compaction prepare returned unknown status: ${String(status)}`);
}

function normalizeCommitResult(value: unknown): CommitConversationCompactionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Compaction commit returned a non-object response");
  }
  const record = value as Record<string, unknown>;
  const status = record["status"];
  if (status === "committed") {
    const checkpointId = safeInteger(record["checkpointId"], "checkpointId", { min: 1 });
    const generation = safeInteger(record["generation"], "generation", { min: 1 });
    return { status: "committed", checkpointId, generation };
  }
  if (status === "stale") return { status: "stale" };
  if (status === "rejected") return { status: "rejected" };
  throw new Error(`Compaction commit returned unknown status: ${String(status)}`);
}

// ── #1515: dream-question response normalization ────────────────────────────
// Every field is bounded and validated; malformed responses fail closed rather
// than becoming a fabricated question or a fake asked/dismissed success.

const DREAM_QUESTION_STATUSES = new Set(["pending", "asked", "resolved", "expired", "dismissed"]);
const DREAM_QUESTION_ID_MAX = 128;
const DREAM_QUESTION_TEXT_MAX = 300;
const DREAM_QUESTION_LIST_MAX = 50;

function normalizeDreamQuestion(value: unknown): DreamQuestionWireLike {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Dream question response is malformed");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || record["id"].length === 0 || record["id"].length > DREAM_QUESTION_ID_MAX) throw new Error("Dream question response has no bounded id");
  if (!Number.isSafeInteger(record["memoryAId"]) || (record["memoryAId"] as number) < 1
    || !Number.isSafeInteger(record["memoryBId"]) || (record["memoryBId"] as number) < 1) throw new Error("Dream question evidence ids are malformed");
  if (typeof record["question"] !== "string" || record["question"].length === 0 || record["question"].length > DREAM_QUESTION_TEXT_MAX) throw new Error("Dream question response has no bounded question text");
  if (typeof record["status"] !== "string" || !DREAM_QUESTION_STATUSES.has(record["status"])) throw new Error("Dream question status is malformed");
  if (!Number.isSafeInteger(record["createdAt"]) || (record["createdAt"] as number) < 0
    || !Number.isSafeInteger(record["expiresAt"]) || (record["expiresAt"] as number) < 0) throw new Error("Dream question timestamps are malformed");
  const wire: DreamQuestionWireLike = {
    id: record["id"],
    memoryAId: record["memoryAId"] as number,
    memoryBId: record["memoryBId"] as number,
    question: record["question"],
    status: record["status"] as DreamQuestionWireLike["status"],
    createdAt: record["createdAt"] as number,
    expiresAt: record["expiresAt"] as number,
  };
  if (record["askedAt"] !== undefined && (!Number.isSafeInteger(record["askedAt"]) || (record["askedAt"] as number) < 0)) {
    throw new Error("Dream question askedAt is malformed");
  }
  if (typeof record["askedAt"] === "number" && Number.isSafeInteger(record["askedAt"])) {
    wire.askedAt = record["askedAt"] as number;
  }
  return wire;
}

function normalizeDreamQuestionList(value: unknown): { questions: DreamQuestionWireLike[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Dream question list response is malformed");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record["questions"])) {
    throw new Error("Dream question list response has no questions array");
  }
  if (record["questions"].length > DREAM_QUESTION_LIST_MAX) {
    throw new Error("Dream question list response exceeds its bound");
  }
  const questions: DreamQuestionWireLike[] = [];
  for (const raw of record["questions"] as unknown[]) {
    questions.push(normalizeDreamQuestion(raw));
  }
  return { questions };
}

function normalizeMarkAskedResult(value: unknown): { status: "asked" | "not_found" | "conflict" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Dream question markAsked response is malformed");
  }
  const status = (value as Record<string, unknown>)["status"];
  if (status === "asked" || status === "not_found" || status === "conflict") {
    return { status };
  }
  throw new Error(`Dream question markAsked returned unknown status: ${String(status)}`);
}

function normalizeDismissResult(value: unknown): { status: "dismissed" | "not_found" | "already_terminal" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Dream question dismiss response is malformed");
  }
  const status = (value as Record<string, unknown>)["status"];
  if (status === "dismissed" || status === "not_found" || status === "already_terminal") {
    return { status };
  }
  throw new Error(`Dream question dismiss returned unknown status: ${String(status)}`);
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
    getSleepStatus: async () => { unavailable("getSleepStatus"); return { state: "idle" }; },
    getCoreKnowledge: async () => { unavailable("getCoreKnowledge"); return ""; },
    recordFeedback: async () => { unavailable("recordFeedback"); return { ok: false }; },
    embed: async () => { unavailable("embed"); return { vectors: [], model: "" }; },
    runMaintenance: async () => { unavailable("runMaintenance"); return { ok: false, summary: "Memory disabled" }; },
    instantStore: async () => { unavailable("instantStore"); return { stored: false, memoriesCount: 0, code: "memory_unavailable", message: "Memory is disabled", requestId: "", retryable: false, action: "stop" as const, stage: "pre_dispatch" as const }; },
    editMemory: async () => { unavailable("editMemory"); return { ok: false, code: "memory_unavailable", message: "Memory is disabled", requestId: "", retryable: false, action: "stop" as const, stage: "pre_dispatch" as const }; },
    rebuildFtsIndexes: async () => { unavailable("rebuildFtsIndexes"); return { rebuilt: [] }; },
    projectDurableContext: async () => { unavailable("projectDurableContext"); throw new Error("Memory is disabled: projectDurableContext not available"); },
    prepareConversationCompaction: async () => { unavailable("prepareConversationCompaction"); throw new Error("Memory is disabled: prepareConversationCompaction not available"); },
    commitConversationCompaction: async () => { unavailable("commitConversationCompaction"); throw new Error("Memory is disabled: commitConversationCompaction not available"); },
    dreamQuestions: {
      nextPending: async () => { unavailable("dreamQuestions.nextPending"); return null; },
      list: async () => { unavailable("dreamQuestions.list"); return { questions: [] }; },
      markAsked: async () => { unavailable("dreamQuestions.markAsked"); return { status: "not_found" as const }; },
      dismiss: async () => { unavailable("dreamQuestions.dismiss"); return { status: "not_found" as const }; },
    },
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
    getSleepStatus: async () => { unavailable("getSleepStatus"); return { state: "idle" }; },
    getCoreKnowledge: async () => { unavailable("getCoreKnowledge"); return ""; },
    recordFeedback: async () => { unavailable("recordFeedback"); return { ok: false }; },
    embed: async () => { unavailable("embed"); return { vectors: [], model: "" }; },
    runMaintenance: async () => { unavailable("runMaintenance"); return { ok: false, summary: "Memory unavailable" }; },
    instantStore: async () => { unavailable("instantStore"); return { stored: false, memoriesCount: 0, code: "memory_unavailable", message: "Memory unavailable", requestId: "", retryable: false, action: "stop" as const, stage: "pre_dispatch" as const }; },
    editMemory: async () => { unavailable("editMemory"); return { ok: false, code: "memory_unavailable", message: "Memory unavailable", requestId: "", retryable: false, action: "stop" as const, stage: "pre_dispatch" as const }; },
    rebuildFtsIndexes: async () => { unavailable("rebuildFtsIndexes"); return { rebuilt: [] }; },
    projectDurableContext: async () => { unavailable("projectDurableContext"); throw new Error("Memory unavailable: projectDurableContext not available"); },
    prepareConversationCompaction: async () => { unavailable("prepareConversationCompaction"); throw new Error("Memory unavailable: prepareConversationCompaction not available"); },
    commitConversationCompaction: async () => { unavailable("commitConversationCompaction"); throw new Error("Memory unavailable: commitConversationCompaction not available"); },
    dreamQuestions: {
      nextPending: async () => { unavailable("dreamQuestions.nextPending"); return null; },
      list: async () => { unavailable("dreamQuestions.list"); return { questions: [] }; },
      markAsked: async () => { unavailable("dreamQuestions.markAsked"); return { status: "not_found" as const }; },
      dismiss: async () => { unavailable("dreamQuestions.dismiss"); return { status: "not_found" as const }; },
    },
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
