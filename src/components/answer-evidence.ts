/**
 * answer-evidence.ts — #1913 execution evidence and answer records.
 *
 * Reaction feedback must target the delivered answer's supporting memories,
 * not every automatic-recall candidate. This module owns both halves:
 *
 * - Tool evidence: memory IDs actually delivered to the agent by successful
 *   `memory_recall` calls, keyed by Spin execution. Automatic injection joins
 *   at publish time from the pipeline's own `recalledHits`.
 * - Answer records: one bounded process-local record per delivered answer,
 *   indexed by (platform, channel, message) with lossless string IDs.
 *
 * Lookup misses (unknown, expired, wrong message) are safe no-ops by
 * contract: callers must never fall back to the automatic recall set.
 * Restart drops all records (process-local Maps), which safely disables
 * feedback for pre-restart messages. Sweeps run on event-driven access;
 * this module owns no timers.
 */

import { logDebug, logWarn } from "./logger.js";

/** Where a feedback signal originates: automatic citation or explicit reaction. */
export type FeedbackSource = "auto" | "explicit";

// ── Bounds ────────────────────────────────────────────────────────────────

export const ANSWER_RECORD_TTL_MS = 60 * 60_000;
const MAX_ANSWER_RECORDS = 500;
const TOOL_EVIDENCE_TTL_MS = 30 * 60_000;
const MAX_TOOL_EXECUTIONS = 200;
const MAX_TOOL_IDS_PER_EXECUTION = 50;
export const MAX_SUPPORT_IDS = 20;

// ── Tool evidence (execution-scoped) ──────────────────────────────────────

interface ToolEvidenceEntry {
  ids: Map<number, number | undefined>;
  at: number;
}

const toolEvidence = new Map<string, ToolEvidenceEntry>();

export interface ToolEvidenceHit {
  readonly memoryId?: number;
  readonly semanticRevision?: number;
}

/** Record memory IDs a successful `memory_recall` delivered to the agent. */
export function recordToolEvidence(
  executionId: string | undefined,
  hits: readonly ToolEvidenceHit[],
  nowMs: number = Date.now(),
): void {
  if (!executionId) return;
  let entry = toolEvidence.get(executionId);
  if (!entry) {
    if (toolEvidence.size >= MAX_TOOL_EXECUTIONS) sweepToolEvidence(nowMs);
    entry = { ids: new Map(), at: nowMs };
    toolEvidence.set(executionId, entry);
  }
  for (const hit of hits) {
    if (entry.ids.size >= MAX_TOOL_IDS_PER_EXECUTION) break;
    if (typeof hit.memoryId === "number" && Number.isInteger(hit.memoryId) && hit.memoryId > 0) {
      if (!entry.ids.has(hit.memoryId)) entry.ids.set(hit.memoryId, hit.semanticRevision);
    }
  }
}

/** Drain one execution's evidence (single reader: answer publication). */
export function takeToolEvidence(
  executionId: string | undefined,
  nowMs: number = Date.now(),
): Map<number, number | undefined> {
  sweepToolEvidence(nowMs);
  if (!executionId) return new Map();
  const entry = toolEvidence.get(executionId);
  toolEvidence.delete(executionId);
  return entry ? entry.ids : new Map();
}

function sweepToolEvidence(nowMs: number): void {
  for (const [key, entry] of toolEvidence) {
    if (nowMs - entry.at > TOOL_EVIDENCE_TTL_MS) toolEvidence.delete(key);
  }
  // Size bound survives clock skew: drop oldest inserts first.
  if (toolEvidence.size > MAX_TOOL_EXECUTIONS) {
    const ordered = [...toolEvidence.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of ordered.slice(0, toolEvidence.size - MAX_TOOL_EXECUTIONS)) toolEvidence.delete(key);
  }
}

// ── Support validation ────────────────────────────────────────────────────

/**
 * Intersect an agent-declared support list with host-observed evidence.
 * Order-preserving, deduplicated, capped. Retrieval alone never qualifies:
 * only IDs present in `available` survive, so a forged or stale declaration
 * degrades to the eligible subset (possibly empty).
 */
export function validateSupportIds(
  declared: readonly number[],
  available: ReadonlySet<number>,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of declared) {
    if (out.length >= MAX_SUPPORT_IDS) break;
    if (!Number.isInteger(id) || id <= 0 || seen.has(id) || !available.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Union the agent's declaration with conservative heuristic support, then
 * validate the union against host-observed evidence. Heuristic IDs already
 * matched injected content, so they survive validation exactly when they
 * name injected memories; anything else degrades to the eligible subset.
 */
export function resolveAnswerSupport(args: {
  readonly declared: readonly number[];
  readonly heuristic: readonly number[];
  readonly autoInjected: readonly number[];
  readonly toolDelivered: ReadonlyMap<number, number | undefined> | ReadonlySet<number>;
}): number[] {
  const available = new Set<number>(args.autoInjected);
  for (const id of args.toolDelivered.keys()) available.add(id);
  return validateSupportIds([...args.declared, ...args.heuristic], available);
}

// ── Answer records ────────────────────────────────────────────────────────

export interface AnswerRecord {
  readonly platform: string;
  readonly channelId: string;
  readonly principal: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly support: readonly number[];
  readonly createdAt: number;
  readonly messageIds: readonly string[];
}

export interface PublishAnswerInput {
  readonly platform: string;
  readonly channelId: string;
  readonly principal: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly support: readonly number[];
  readonly messageIds: readonly string[];
}

const answerRecords = new Map<string, { record: AnswerRecord; at: number }>();

function answerKey(platform: string, channelId: string, messageId: string): string {
  return `${platform.length}:${platform}:${channelId.length}:${channelId}:${messageId}`;
}

/**
 * Publish one record per delivered answer; every delivered chunk aliases the
 * same record. Fully synchronous: callers publish immediately after the
 * platform send resolves, so no reaction can resolve before registration.
 * Empty support publishes nothing (reactions then miss by contract).
 */
export function publishAnswerRecord(input: PublishAnswerInput, nowMs: number = Date.now()): void {
  if (input.messageIds.length === 0 || input.support.length === 0) return;
  sweepAnswerRecords(nowMs);
  const record: AnswerRecord = {
    platform: input.platform,
    channelId: input.channelId,
    principal: input.principal,
    sessionId: input.sessionId,
    executionId: input.executionId,
    support: [...input.support],
    createdAt: nowMs,
    messageIds: [...input.messageIds],
  };
  const entry = { record, at: nowMs };
  for (const messageId of input.messageIds) {
    answerRecords.set(answerKey(input.platform, input.channelId, messageId), entry);
  }
}

/** Resolve a reaction target. Misses (unknown/expired) are safe no-ops. */
export function lookupAnswerRecord(
  platform: string,
  channelId: string,
  messageId: string,
  nowMs: number = Date.now(),
): AnswerRecord | undefined {
  const key = answerKey(platform, channelId, messageId);
  const entry = answerRecords.get(key);
  if (!entry) return undefined;
  if (nowMs - entry.at > ANSWER_RECORD_TTL_MS) {
    // Expired records die on access; shared entry dies with its last alias.
    for (const alias of entry.record.messageIds) {
      if (answerRecords.get(answerKey(entry.record.platform, entry.record.channelId, alias)) === entry) {
        answerRecords.delete(answerKey(entry.record.platform, entry.record.channelId, alias));
      }
    }
    return undefined;
  }
  return entry.record;
}

function sweepAnswerRecords(nowMs: number): void {
  for (const [key, entry] of answerRecords) {
    if (nowMs - entry.at > ANSWER_RECORD_TTL_MS) answerRecords.delete(key);
  }
  if (answerRecords.size > MAX_ANSWER_RECORDS) {
    const ordered = [...answerRecords.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of ordered.slice(0, answerRecords.size - MAX_ANSWER_RECORDS)) answerRecords.delete(key);
  }
}

// ── Feedback outcomes ─────────────────────────────────────────────────────

export interface FeedbackOutcome {
  readonly applied: number[];
  readonly rejected: number[];
  readonly unknown: number[];
}

export interface FeedbackTarget {
  readonly memoryId: number;
  readonly operationKey: string;
}

interface FeedbackRuntime {
  recordFeedback(
    input: { userId: string; memoryId: number; feedbackType: "cite" | "reject" },
    operationKey: string,
  ): Promise<unknown>;
}

const REJECT_PATTERNS = [/unauthorized/i, /forbidden/i, /owner/i, /permission/i, /no longer belong/i];

/**
 * Attempt one feedback write per target under its own idempotency identity.
 * Never retries: rejected stays rejected, unknown is reported (never
 * reissued under a new key). Bounded diagnostics only — no memory content.
 */
export async function recordFeedbackBatch(
  runtime: FeedbackRuntime,
  userId: string,
  feedbackType: "cite" | "reject",
  targets: readonly FeedbackTarget[],
): Promise<FeedbackOutcome> {
  const applied: number[] = [];
  const rejected: number[] = [];
  const unknown: number[] = [];
  for (const target of targets) {
    try {
      await runtime.recordFeedback({ userId, memoryId: target.memoryId, feedbackType }, target.operationKey);
      applied.push(target.memoryId);
    } catch (err) {
      const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (REJECT_PATTERNS.some((re) => re.test(text))) rejected.push(target.memoryId);
      else unknown.push(target.memoryId);
    }
  }
  if (rejected.length > 0 || unknown.length > 0) {
    logWarn("answer-evidence", `feedback partial: applied=${applied.length} rejected=${rejected.length} unknown=${unknown.length} type=${feedbackType}`);
  } else {
    logDebug("answer-evidence", `feedback applied: ${applied.length} memories (${feedbackType})`);
  }
  return { applied, rejected, unknown };
}

/** Terse machine-readable outcome for reaction signals, so model-generated
 *  acknowledgements cannot claim a failed write succeeded. */
export function formatFeedbackOutcome(outcome: FeedbackOutcome): string {
  const parts = [`${outcome.applied.length} applied`];
  if (outcome.rejected.length > 0) parts.push(`${outcome.rejected.length} rejected`);
  if (outcome.unknown.length > 0) parts.push(`${outcome.unknown.length} unknown`);
  return parts.join(", ");
}

// ── Overlap detection ─────────────────────────────────────────────────────

const OVERLAP_PATTERNS = [/already active/i, /overlapping sendPrompt/i, /already in progress/i, /type_busy/i];

/** True when starting a model call now would race an in-flight execution:
 *  the caller must queue instead of starting concurrent work. */
export function isExecutionOverlapError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err && typeof (err as { name: unknown }).name === "string"
    ? (err as { name: string }).name
    : "";
  if (name === "SpinDispatchAdmissionError") return true;
  const message = err instanceof Error ? err.message : String(err);
  return OVERLAP_PATTERNS.some((re) => re.test(message));
}
