import { createHash } from "node:crypto";
import type {
  AbmindClientLike,
  AbmindClientErrorLike,
  AbmindPrivateMemoryLike,
  AbmindRouteSnapshotV1Like,
  SleepStatusLike,
} from "./abmind-client-contract.js";

import { logDebug, logTrace, logWarn, isLogLevel, redactSecrets } from "./logger.js";
import type { MemoryMutationFamily } from "./memory-operation-key.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type RuntimeState = "ready" | "disabled" | "unavailable";

export type MemoryRuntimeCapability =
  | "recall"
  | "recordMessage"
  | "instantStore"
  | "rebuildFts"
  | "coreKnowledge"
  | "status"
  | "dreamQuestions"
  | "dreamQuestionsNextPending"
  // #1660: composite local sealed-secret capability (find + resolve on a
  // local route). Absent for signed peers and remote routes.
  | "sealedSecrets";

export interface InstantStoreInput {
  userId: string;
  contentEn: string;
  contentOriginal: string;
  memoryType: string;
  emotionScore: number;
  confidence: number;
  classification: number;
  /** #1660: class-3 only — descriptive label stored in content_en. */
  sealedLabel?: string;
  /** #1660: class-3 only — non-sensitive retrieval keyword. */
  sealedKeyword?: string;
}

/**
 * #1659: normalized structural mutation failure shared by mutation paths.
 * Fields are preserved from the protocol contract; the bridge code keeps its
 * own stable `memory_*` classification.
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
  /**
   * #1928 M4 — required logical profile. Fast is compact regardless of
   * route; normal/full are deliberate and never auto-skip. Auto-recall
   * uses fast; explicit tools select normal/full.
   */
  profile: "recall_fast" | "recall_normal" | "recall_full";
  /** Fast requires the verbatim current turn. */
  rawTurn?: string;
  /** Normal/full anchor: verbatim explicit text and/or 1–50 keywords. */
  text?: string;
  keywords?: string[];
  /** Selected items, bounded by the profile ceiling. */
  limit?: number;
  maxOutputBytes?: number;
  deadlineMs?: number;
  maxClassification?: number;
  timeStart?: number;
  timeEnd?: number;
  memoryType?: string;
  scope?: string;
  asOf?: string;
  continuation?: string;
}


export interface RuntimeRecallHit {
  /** Owner-rendered excerpt; injected verbatim, never re-rendered locally. */
  content: string;
  date: string;
  /**
   * #1928 M4 — source-safe C2 ref key (`db:<layer>:<id>:<owner>:<version>`,
   * `artifact:…`, `graph:…`). Numeric IDs never identify evidence alone;
   * citations and support declarations name this ref.
   */
  ref: string;
  kind: "db" | "artifact" | "graph";
  layer?: string;
  rationale?: string;
  excerptProvenance?: string;
  currentness?: string;
  score?: number;
  classification?: number;
}

export interface RuntimeRecallResult {
  hits: RuntimeRecallHit[];
  /** Owner-rendered text; injected verbatim. No local clipping. */
  context: string;
  /** Packet status: skipped | empty | evidence | partial | unavailable | cancelled. */
  status: string;
  packetId?: string;
  omissionReasons?: string[];
  continuation?: string;
}

/**
 * #1895 — narrow caller keywords for the explicit path. Accepted arrays
 * cross verbatim (order, duplicates, and case preserved; no cap): any
 * documented resource limit rejects oversize input explicitly rather than
 * truncating it. Anything else is a caller bug and throws here, before any
 * retrieval runs on a silently shortened or substituted query.
 */
export function asExplicitKeywords(keywords: unknown): string[] {
  if (!Array.isArray(keywords) || keywords.length === 0) {
    throw new Error("explicit keywords must be a non-empty array of non-blank strings");
  }
  const accepted: string[] = [];
  for (const keyword of keywords) {
    if (typeof keyword !== "string" || keyword.trim().length === 0) {
      throw new Error("explicit keywords must be a non-empty array of non-blank strings");
    }
    accepted.push(keyword);
  }
  return accepted;
}

export interface SessionContextInput {
  identity: { principalId: string; executionId: string };
  prompt?: string;
  modelContextTokens?: number;
  wakeUpMaxChars?: number;
  includeHistory?: boolean;
}

export interface SessionContextResult {
  wakeUp: string;
  recall: string;
  coreKnowledge: string;
  soulBundle: SessionSoulBundle;
  // #1869 — addressable parts from new daemons; absent on older ones, which
  // serve only the legacy fields. Session-start prefers parts when present.
  parts?: SessionSoulBundle;
}

export interface SessionSoulBundle {
  soul: string;
  profile: string;
  notes: string;
  memoryTools: string;
  coreFacts: string;
}

/**
 * #1869 — narrow the unknown wire parts map. Malformed or absent input
 * yields undefined: the caller falls back to the legacy fields, never a
 * fabricated or partial bundle.
 */
export function asSessionSoulBundle(raw: unknown): SessionSoulBundle | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  for (const key of ["soul", "profile", "notes", "memoryTools", "coreFacts"]) {
    if (typeof record[key] !== "string") return undefined;
  }
  return {
    soul: record["soul"] as string,
    profile: record["profile"] as string,
    notes: record["notes"] as string,
    memoryTools: record["memoryTools"] as string,
    coreFacts: record["coreFacts"] as string,
  };
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
  dbSizeBytes: number;
  rejectedByScanner: number;
  uptimeMs?: number;
  // #1869 — daemon test-mode state. Older daemons omit it; absence means
  // false (full bundle).
  memoryTest: boolean;
}

export interface CoreKnowledgeInput {
  userId: string;
}

export type CoreKnowledgeResult = string;

export interface MaintenanceInput {
  operation: "integrity" | "fts_rebuild" | "wal_checkpoint";
}

export interface MaintenanceResult {
  ok: boolean;
  summary: string;
}

export interface EmbeddingInput { texts: string[] }
export interface EmbeddingResult { vectors: Array<number[] | null>; model: string }

// ── #1660: sealed secrets (labels metadata + local-only plaintext) ───────────

export interface SealedSecretRef {
  readonly memoryId: number;
  readonly semanticRevision: number;
  readonly label: string;
  readonly memoryType: string;
  readonly createdAt: number;
}

export interface FindSealedSecretsInput {
  readonly userId: string;
  readonly query: string;
  readonly limit?: number;
}

export type SealedSecretResolution =
  | { ok: true; value: string; semanticRevision: number }
  | { ok: false; code: "sealed_resolution_failed" };

export interface ResolveSealedSecretInput {
  readonly userId: string;
  readonly memoryId: number;
  readonly expectedRevision: number;
}

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

/** #1706: bounded reason codes for late memory composition. Closed union —
 *  raw endpoint messages never enter diagnostics or status rendering. */
export type MemoryCompositionFailureCode =
  | "config_invalid"
  | "package_missing"
  | "endpoint_unavailable"
  | "pin_mismatch"
  | "authentication_failed"
  | "negotiation_failed"
  | "policy_rejected"
  | "retry_exhausted";

/** #1706: immutable snapshot of re-composition progress for a runtime whose
 *  initial boot-time negotiation failed. */
export interface MemoryCompositionDiagnostics {
  state: "idle" | "retrying" | "upgraded" | "cancelled";
  attempts: number;
  lastAttemptAt?: number;
  lastFailure?: MemoryCompositionFailureCode;
  upgradedAt?: number;
}

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
  embed(input: EmbeddingInput): Promise<EmbeddingResult>;
  runMaintenance(input: MaintenanceInput): Promise<MaintenanceResult>;
  instantStore(input: InstantStoreInput): Promise<InstantStoreResult>;
  rebuildFtsIndexes(): Promise<{ rebuilt: string[] }>;
  /** #1515: optional owner-scoped dream-question lifecycle. Presence of the
   *  `dreamQuestions` capability is checked independently of core recall. */
  dreamQuestions: {
    nextPending(userId: string): Promise<DreamQuestionWireLike | null>;
    list(userId: string, status?: DreamQuestionStatusLike, limit?: number): Promise<{ questions: DreamQuestionWireLike[] }>;
    markAsked(userId: string, questionId: string, deliveryKey: string): Promise<{ status: "asked" | "not_found" | "conflict" }>;
    dismiss(userId: string, questionId: string): Promise<{ status: "dismissed" | "not_found" | "already_terminal" }>;
  };
  /** #1660: owner-only sealed label search (metadata only). */
  findSealedSecrets(input: FindSealedSecretsInput): Promise<SealedSecretRef[]>;
  /** #1660: local-only plaintext resolution, revision-checked. */
  resolveSealedSecret(input: ResolveSealedSecretInput): Promise<SealedSecretResolution>;
  /** #1706: bounded late-composition diagnostics. Present only on
   *  re-composable facades; ordinary disabled/client runtimes omit it. */
  readonly compositionDiagnostics?: MemoryCompositionDiagnostics;
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
  if (methods.has("private.rebuildFts") && features["private_write"] === "true") result.add("rebuildFts");
  if (methods.has("private.getCoreKnowledge")) result.add("coreKnowledge");
  if (methods.has("private.getRuntimeStatus")) result.add("status");
  if (methods.has("private.dreamQuestions.nextPending")) result.add("dreamQuestionsNextPending");
  if (methods.has("private.dreamQuestions.nextPending")
    && methods.has("private.dreamQuestions.list")
    && methods.has("private.dreamQuestions.markAsked")
    && methods.has("private.dreamQuestions.dismiss")) result.add("dreamQuestions");
  // #1660: composite local sealed-secret capability. Signed peers never
  // negotiate the resolver (abmind strips both methods), so their presence in
  // the negotiated method set implies a local route.
  if (methods.has("private.findSealedSecrets") && methods.has("private.resolveSealedSecret")) {
    result.add("sealedSecrets");
  }

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

/**
 * #1928 M4 — narrow the unknown owner packet (validated, not cast). A
 * malformed packet fails the recall loudly instead of injecting a lie:
 * the owner text is only delivered when its items carry complete C2 refs.
 */
interface OwnedPacketItem {
  excerpt: string;
  refKey: string;
  kind: "db" | "artifact" | "graph";
  layer?: string;
  rationale?: string;
  provenance?: string;
  currentness?: string;
  score?: number;
  classification?: number;
}

interface OwnedPacket {
  profile: string;
  status: string;
  items: OwnedPacketItem[];
  text: string;
  packetId?: string;
  omissionReasons?: string[];
  continuation?: string;
}

function ownedRefKey(ref: Record<string, unknown>): string | undefined {
  if (ref["kind"] === "db") {
    const layer = ref["layer"];
    const recordId = ref["recordId"];
    const owner = ref["owner"];
    const version = ref["version"];
    if ((layer === "durable" || layer === "episode" || layer === "raw")
      && Number.isSafeInteger(recordId) && typeof owner === "string" && owner.length > 0
      && typeof version === "string" && version.length > 0) {
      return `db:${layer}:${recordId}:${owner}:${version}`;
    }
    return undefined;
  }
  if (ref["kind"] === "artifact") {
    const owner = ref["owner"];
    const artifact = ref["artifact"];
    const contentVersion = ref["contentVersion"];
    if (typeof owner === "string" && owner.length > 0 && typeof artifact === "string" && artifact.length > 0
      && typeof contentVersion === "string" && contentVersion.length > 0) {
      return `artifact:${owner}:${artifact}:${contentVersion}`;
    }
    return undefined;
  }
  if (ref["kind"] === "graph") {
    const edge = ref["edge"];
    const sources = ref["sources"];
    if (typeof edge === "string" && edge.length > 0 && Array.isArray(sources)
      && sources.every((s) => typeof s === "string")) {
      return `graph:${edge}:${(sources as string[]).join("+")}`;
    }
    return undefined;
  }
  return undefined;
}

function asOwnedPacket(raw: unknown): OwnedPacket {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("recall returned a malformed owner packet");
  }
  const record = raw as Record<string, unknown>;
  if (record["contract"] !== "owned-v1") throw new Error("recall returned an unsupported contract");
  if (typeof record["profile"] !== "string" || typeof record["status"] !== "string") {
    throw new Error("recall returned a malformed owner packet");
  }
  if (typeof record["text"] !== "string" || !Array.isArray(record["items"])) {
    throw new Error("recall returned a malformed owner packet");
  }
  const items: OwnedPacketItem[] = [];
  for (const entry of record["items"] as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("recall returned a malformed owner packet item");
    }
    const item = entry as Record<string, unknown>;
    if (typeof item["excerpt"] !== "string") throw new Error("recall returned a malformed owner packet item");
    const ref = item["ref"];
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      throw new Error("recall returned an item without a C2 ref");
    }
    const refKey = ownedRefKey(ref as Record<string, unknown>);
    if (refKey === undefined) throw new Error("recall returned an item with an incomplete C2 ref");
    const kind = (ref as Record<string, unknown>)["kind"];
    if (kind !== "db" && kind !== "artifact" && kind !== "graph") {
      throw new Error("recall returned an item with an incomplete C2 ref");
    }
    const layer = (ref as Record<string, unknown>)["layer"];
    items.push({
      excerpt: item["excerpt"] as string,
      refKey,
      kind,
      ...(typeof layer === "string" ? { layer } : {}),
      ...(typeof item["rationale"] === "string" ? { rationale: item["rationale"] as string } : {}),
      ...(typeof item["excerptProvenance"] === "string" ? { provenance: item["excerptProvenance"] as string } : {}),
      ...(typeof item["currentness"] === "string" ? { currentness: item["currentness"] as string } : {}),
      ...(typeof item["score"] === "number" ? { score: item["score"] as number } : {}),
      ...(typeof item["classification"] === "number" ? { classification: item["classification"] as number } : {}),
    });
  }
  const omissionReasons = record["omissionReasons"];
  return {
    profile: record["profile"] as string,
    status: record["status"] as string,
    items,
    text: record["text"] as string,
    ...(typeof record["packetId"] === "string" ? { packetId: record["packetId"] as string } : {}),
    ...(Array.isArray(omissionReasons) && omissionReasons.every((r) => typeof r === "string")
      ? { omissionReasons: omissionReasons as string[] }
      : {}),
    ...(typeof record["continuation"] === "string" ? { continuation: record["continuation"] as string } : {}),
  };
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
      const t0 = Date.now();
      logDebug("memory-runtime", `recall: profile=${input.profile} query="${redactSecrets(input.query).slice(0, 60)}" user=${input.userId} limit=${input.limit ?? "profile"} maxClass=${input.maxClassification ?? "?"}`);
      // #1928 M4 — the bridge passes raw/context/identity/capacity and
      // consumes the owner packet. No semantic hints, floors, reranking,
      // numeric-ref selection, or local rendering: the owner text travels
      // intact and the owner ref keys identify every hit.
      const profileBounds = input.profile === "recall_fast"
        ? { maxItems: 5, maxOutputBytes: 2000 }
        : input.profile === "recall_normal"
          ? { maxItems: 15, maxOutputBytes: 12000 }
          : { maxItems: 40, maxOutputBytes: 32768 };
      const request: Record<string, unknown> = {
        contract: "owned-v1",
        profile: input.profile,
        identity: { principal: input.userId },
        ...(input.profile === "recall_fast"
          ? { rawTurn: (input.rawTurn ?? input.query).trim() }
          : {
              query: {
                ...(input.text !== undefined ? { text: input.text } : {}),
                ...((() => {
                  const keywords = input.keywords !== undefined ? asExplicitKeywords(input.keywords) : [];
                  return keywords.length > 0 ? { keywords } : {};
                })()),
              },
            }),
        ...((input.maxClassification !== undefined || input.timeStart !== undefined || input.timeEnd !== undefined || input.memoryType !== undefined || input.scope !== undefined || input.asOf !== undefined)
          ? {
              filters: {
                ...(input.memoryType !== undefined ? { memoryType: input.memoryType } : {}),
                ...(input.scope !== undefined ? { scope: input.scope } : {}),
                ...(input.timeStart !== undefined ? { timeStart: input.timeStart } : {}),
                ...(input.timeEnd !== undefined ? { timeEnd: input.timeEnd } : {}),
                ...(input.maxClassification !== undefined ? { classificationCeiling: input.maxClassification } : {}),
                ...(input.asOf !== undefined ? { asOf: input.asOf } : {}),
              },
            }
          : {}),
        capacity: {
          maxItems: Math.max(1, Math.min(input.limit ?? profileBounds.maxItems, profileBounds.maxItems)),
          maxOutputBytes: Math.max(64, Math.min(input.maxOutputBytes ?? profileBounds.maxOutputBytes, profileBounds.maxOutputBytes)),
          ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
        },
        ...(input.continuation !== undefined ? { continuation: input.continuation } : {}),
      };
      const packet = asOwnedPacket(await pm.recall(request));
      const hits: RuntimeRecallHit[] = packet.items.map((item) => ({
        content: item.excerpt,
        date: "",
        ref: item.refKey,
        kind: item.kind,
        ...(item.layer !== undefined ? { layer: item.layer } : {}),
        ...(item.rationale !== undefined ? { rationale: item.rationale } : {}),
        ...(item.provenance !== undefined ? { excerptProvenance: item.provenance } : {}),
        ...(item.currentness !== undefined ? { currentness: item.currentness } : {}),
        ...(item.score !== undefined ? { score: item.score } : {}),
        ...(item.classification !== undefined ? { classification: item.classification } : {}),
      }));
      const ms = Date.now() - t0;
      logDebug("memory-runtime", `recall: profile=${packet.profile} status=${packet.status} hits=${hits.length} in ${ms}ms omissions=${(packet.omissionReasons ?? []).length}`);
      if (isLogLevel("trace")) {
        for (const h of hits.slice(0, 10)) {
          logTrace("memory-runtime", `hit ref=${h.ref} text="${redactSecrets(h.content).slice(0, 120)}"`);
        }
      }
      return {
        hits,
        context: packet.text,
        status: packet.status,
        ...(packet.packetId !== undefined ? { packetId: packet.packetId } : {}),
        ...(packet.omissionReasons !== undefined ? { omissionReasons: packet.omissionReasons } : {}),
        ...(packet.continuation !== undefined ? { continuation: packet.continuation } : {}),
      };
    },

    async assembleSessionContext(input: SessionContextInput): Promise<SessionContextResult> {
      const assembled = await pm.assembleSessionContext({
        userId: input.identity.principalId,
        modelContextTokens: input.modelContextTokens,
        wakeUpMaxChars: input.wakeUpMaxChars,
        includeHistory: input.includeHistory,
      });
      // #1869 — parts ride the existing method (no new capability): older
      // daemons omit them and the caller falls back to the legacy fields.
      // Shape validation lives with the consumer (asSessionSoulBundle).
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
        dbSizeBytes: typeof stats["dbSizeBytes"] === "number" ? stats["dbSizeBytes"] : 0,
        rejectedByScanner: typeof stats["rejectedByScanner"] === "number" ? stats["rejectedByScanner"] : 0,
        // #1869 — older daemons omit the mode; absence means full bundle.
        memoryTest: stats["memoryTest"] === true,
      };
    },

    async getSleepStatus(): Promise<SleepStatusLike> {
      return await client.sleep.status();
    },

    async getCoreKnowledge(input: CoreKnowledgeInput): Promise<CoreKnowledgeResult> {
      return (await pm.getCoreKnowledge(input)) as CoreKnowledgeResult;
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
          // #1660: class-3 sealed stores carry label/keyword explicitly; the
          // value must never ride in the label-bearing field.
          sealedLabel: input.sealedLabel,
          sealedKeyword: input.sealedKeyword,
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

    async rebuildFtsIndexes(): Promise<{ rebuilt: string[] }> {
      requireClientCapability(capabilities, "rebuildFts");
      return (await pm.rebuildFtsIndexes()) as { rebuilt: string[] };
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

    async findSealedSecrets(input: FindSealedSecretsInput): Promise<SealedSecretRef[]> {
      requireClientCapability(capabilities, "sealedSecrets");
      const result = (await pm.findSealedSecrets(input)) as unknown;
      if (!Array.isArray(result)) throw new Error("Sealed secret search returned a non-array response");
      return result.map((raw) => {
        const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        return {
          memoryId: typeof r["memoryId"] === "number" ? r["memoryId"] : 0,
          semanticRevision: typeof r["semanticRevision"] === "number" ? r["semanticRevision"] : 0,
          label: typeof r["label"] === "string" ? r["label"] : "",
          memoryType: typeof r["memoryType"] === "string" ? r["memoryType"] : "",
          createdAt: typeof r["createdAt"] === "number" ? r["createdAt"] : 0,
        };
      });
    },

    async resolveSealedSecret(input: ResolveSealedSecretInput): Promise<SealedSecretResolution> {
      requireClientCapability(capabilities, "sealedSecrets");
      try {
        const result = (await pm.resolveSealedSecret(input)) as unknown;
        if (result && typeof result === "object" && (result as Record<string, unknown>)["ok"] === true) {
          const value = (result as Record<string, unknown>)["value"];
          if (typeof value === "string") {
            return { ok: true, value, semanticRevision: Number((result as Record<string, unknown>)["semanticRevision"] ?? 0) };
          }
        }
        return { ok: false, code: "sealed_resolution_failed" };
      } catch {
        // #1660: every failure — dispatch refusal, forged frame, wrong owner,
        // stale revision, expired row — collapses to the same indistinguishable
        // outcome so callers can never learn whether another owner's row exists.
        return { ok: false, code: "sealed_resolution_failed" };
      }
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
  return self;
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
    recall: async () => { unavailable("recall"); return { hits: [], context: "", status: "unavailable" }; },
    assembleSessionContext: async () => { unavailable("assembleSessionContext"); return { wakeUp: "", recall: "", coreKnowledge: "", soulBundle: emptySoulBundle() }; },
    getRecentConversation: async () => { unavailable("getRecentConversation"); return []; },
    getStatus: async () => { unavailable("getStatus"); return { totalMessages: 0, extractedMemories: 0, extractedByType: {}, consolidationFiles: { daily: 0, weekly: 0, quarterly: 0 }, dbSizeBytes: 0, rejectedByScanner: 0, memoryTest: false }; },
    getSleepStatus: async () => { unavailable("getSleepStatus"); return { state: "idle" }; },
    getCoreKnowledge: async () => { unavailable("getCoreKnowledge"); return ""; },
    embed: async () => { unavailable("embed"); return { vectors: [], model: "" }; },
    runMaintenance: async () => { unavailable("runMaintenance"); return { ok: false, summary: "Memory disabled" }; },
    instantStore: async () => { unavailable("instantStore"); return { stored: false, memoriesCount: 0, code: "memory_unavailable", message: "Memory is disabled", requestId: "", retryable: false, action: "stop" as const, stage: "pre_dispatch" as const }; },
    rebuildFtsIndexes: async () => { unavailable("rebuildFtsIndexes"); return { rebuilt: [] }; },
    dreamQuestions: {
      nextPending: async () => { unavailable("dreamQuestions.nextPending"); return null; },
      list: async () => { unavailable("dreamQuestions.list"); return { questions: [] }; },
      markAsked: async () => { unavailable("dreamQuestions.markAsked"); return { status: "not_found" as const }; },
      dismiss: async () => { unavailable("dreamQuestions.dismiss"); return { status: "not_found" as const }; },
    },
    findSealedSecrets: async () => { unavailable("findSealedSecrets"); return []; },
    resolveSealedSecret: async () => { unavailable("resolveSealedSecret"); return { ok: false as const, code: "sealed_resolution_failed" as const }; },
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
    recall: async () => { unavailable("recall"); return { hits: [], context: "", status: "unavailable" }; },
    assembleSessionContext: async () => { unavailable("assembleSessionContext"); return { wakeUp: "", recall: "", coreKnowledge: "", soulBundle: emptySoulBundle() }; },
    getRecentConversation: async () => { unavailable("getRecentConversation"); return []; },
    getStatus: async () => { unavailable("getStatus"); return { totalMessages: 0, extractedMemories: 0, extractedByType: {}, consolidationFiles: { daily: 0, weekly: 0, quarterly: 0 }, dbSizeBytes: 0, rejectedByScanner: 0, memoryTest: false }; },
    getSleepStatus: async () => { unavailable("getSleepStatus"); return { state: "idle" }; },
    getCoreKnowledge: async () => { unavailable("getCoreKnowledge"); return ""; },
    embed: async () => { unavailable("embed"); return { vectors: [], model: "" }; },
    runMaintenance: async () => { unavailable("runMaintenance"); return { ok: false, summary: "Memory disabled" }; },
    instantStore: async () => { unavailable("instantStore"); return { stored: false, memoriesCount: 0, code: "memory_unavailable", message: "Memory unavailable", requestId: "", retryable: false, action: "stop" as const, stage: "pre_dispatch" as const }; },
    rebuildFtsIndexes: async () => { unavailable("rebuildFtsIndexes"); return { rebuilt: [] }; },
    dreamQuestions: {
      nextPending: async () => { unavailable("dreamQuestions.nextPending"); return null; },
      list: async () => { unavailable("dreamQuestions.list"); return { questions: [] }; },
      markAsked: async () => { unavailable("dreamQuestions.markAsked"); return { status: "not_found" as const }; },
      dismiss: async () => { unavailable("dreamQuestions.dismiss"); return { status: "not_found" as const }; },
    },
    findSealedSecrets: async () => { unavailable("findSealedSecrets"); return []; },
    resolveSealedSecret: async () => { unavailable("resolveSealedSecret"); return { ok: false as const, code: "sealed_resolution_failed" as const }; },
    close: async () => {},
  };
}

function emptySoulBundle(): SessionSoulBundle {
  return { soul: "", profile: "", notes: "", memoryTools: "", coreFacts: "" };
}

// ── Memory mutation isolation ─────────────────────────────────────────────

export type MemoryWritePhase = "before_model" | "after_delivery";

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
