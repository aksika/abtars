/**
 * answer-evidence.ts — #1913 execution evidence and answer records.
 *
 * Delivery tracking only (#1928 A13 retired the cite/reject feedback write):
 *
 * - Tool evidence: memory IDs actually delivered to the agent by successful
 *   `memory_recall` calls, keyed by Spin execution. Automatic injection joins
 *   when each segment's support is captured from the pipeline's `recalledHits`.
 * - Answer records: bounded process-local records for delivered segments,
 *   indexed by (platform, channel, message) with lossless string IDs.
 *
 * Lookup misses (unknown, expired, wrong message) are safe no-ops by
 * contract: callers must never fall back to the automatic recall set.
 * Restart drops all records (process-local Maps). Sweeps run on event-driven
 * access; the send-race resolver alone uses a short, cleared deadline.
 */

// ── Bounds ────────────────────────────────────────────────────────────────

export const ANSWER_RECORD_TTL_MS = 60 * 60_000;
const MAX_ANSWER_RECORDS = 500;
const TOOL_EVIDENCE_TTL_MS = 30 * 60_000;
const MAX_TOOL_EXECUTIONS = 200;
const MAX_TOOL_IDS_PER_EXECUTION = 50;
export const MAX_SUPPORT_IDS = 20;

// ── Tool evidence (execution-scoped) ──────────────────────────────────────

interface ToolEvidenceEntry {
  ids: Set<string>;
  at: number;
}

const toolEvidence = new Map<string, ToolEvidenceEntry>();

export interface ToolEvidenceHit {
  readonly ref?: string;
}

/**
 * #1928 M4 — record owner ref keys a successful `memory_recall` delivered
 * to the agent. Numeric memory IDs no longer exist on this path.
 */
export function recordToolEvidence(
  executionId: string | undefined,
  hits: readonly ToolEvidenceHit[],
  nowMs: number = Date.now(),
): void {
  if (!executionId) return;
  let entry = toolEvidence.get(executionId);
  if (!entry) {
    if (toolEvidence.size >= MAX_TOOL_EXECUTIONS) sweepToolEvidence(nowMs);
    entry = { ids: new Set(), at: nowMs };
    toolEvidence.set(executionId, entry);
  }
  for (const hit of hits) {
    if (entry.ids.size >= MAX_TOOL_IDS_PER_EXECUTION) break;
    if (typeof hit.ref === "string" && hit.ref.length > 0) entry.ids.add(hit.ref);
  }
  sweepToolEvidence(nowMs);
}

/** Drain one execution's evidence after pipeline settlement. */
export function takeToolEvidence(
  executionId: string | undefined,
  nowMs: number = Date.now(),
): Set<string> {
  sweepToolEvidence(nowMs);
  if (!executionId) return new Set();
  const entry = toolEvidence.get(executionId);
  toolEvidence.delete(executionId);
  return entry ? new Set(entry.ids) : new Set();
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

/** Snapshot for an incremental segment: later tool reads cannot change it. */
export function peekToolEvidence(executionId: string | undefined): ReadonlySet<string> {
  sweepToolEvidence(Date.now());
  return new Set(executionId ? toolEvidence.get(executionId)?.ids : undefined);
}

/** Only a complete, successful model-facing recall envelope supplies evidence. */
export function recordDeliveredRecall(executionId: string, delivered: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(delivered); } catch { return; /* truncated/non-JSON output cannot establish complete evidence */ }
  if (!parsed || typeof parsed !== "object" || "error" in parsed || !("hits" in parsed) || !Array.isArray(parsed.hits)) return;
  const hits: ToolEvidenceHit[] = [];
  for (const hit of parsed.hits) {
    if (!hit || typeof hit !== "object" || !("ref" in hit) || typeof hit.ref !== "string") continue;
    hits.push({ ref: hit.ref });
  }
  recordToolEvidence(executionId, hits);
}

// ── Support validation ────────────────────────────────────────────────────

/**
 * Intersect an agent-declared support list with host-observed evidence.
 * Order-preserving, deduplicated, capped. Retrieval alone never qualifies:
 * only IDs present in `available` survive, so a forged or stale declaration
 * degrades to the eligible subset (possibly empty).
 */
export function validateSupportIds(
  declared: readonly string[],
  available: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of declared) {
    if (out.length >= MAX_SUPPORT_IDS) break;
    if (typeof id !== "string" || id.length === 0 || seen.has(id) || !available.has(id)) continue;
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
  readonly declared: readonly string[];
  readonly heuristic: readonly string[];
  readonly autoInjected: readonly string[];
  readonly toolDelivered: ReadonlySet<string>;
}): string[] {
  const available = new Set<string>(args.autoInjected);
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
  readonly support: readonly string[];
  readonly createdAt: number;
  readonly messageIds: readonly string[];
}

export interface PublishAnswerInput {
  readonly platform: string;
  readonly channelId: string;
  readonly principal: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly support: readonly string[];
  readonly messageIds: readonly string[];
}

const answerRecords = new Map<string, { record: AnswerRecord; at: number }>();

function answerKey(platform: string, channelId: string, messageId: string): string {
  return `${platform.length}:${platform}:${channelId.length}:${channelId}:${messageId}`;
}

/**
 * Publish a segment's captured support as soon as its send is acknowledged.
 * Chunk records share an execution identity. Reactions arriving before
 * acknowledgement use the bounded send resolver. Empty support publishes
 * nothing (reactions then miss by contract).
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
  sweepAnswerRecords(nowMs);
}

// A platform can emit a reaction before its send promise returns the message
// ID. Wait only for current sends in this channel, with a bounded deadline.
const pendingAnswerSends = new Map<string, Set<Promise<void>>>();

export function beginAnswerSend(platform: string, channelId: string): () => void {
  const key = answerKey(platform, channelId, "");
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => { settle = resolve; });
  const sends = pendingAnswerSends.get(key) ?? new Set<Promise<void>>();
  sends.add(pending);
  pendingAnswerSends.set(key, sends);
  return () => {
    sends.delete(pending);
    if (sends.size === 0) pendingAnswerSends.delete(key);
    settle();
  };
}

export async function resolveReactionAnswer(platform: string, channelId: string, messageId: string): Promise<AnswerRecord | undefined> {
  const record = lookupAnswerRecord(platform, channelId, messageId);
  if (record) return record;
  const sends = pendingAnswerSends.get(answerKey(platform, channelId, ""));
  if (!sends?.size) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([...sends]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); timer.unref(); }),
    ]);
  } finally { clearTimeout(timer); }
  return lookupAnswerRecord(platform, channelId, messageId);
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

// ── Overlap detection ─────────────────────────────────────────────────────

const OVERLAP_PATTERNS = [/already active/i, /overlapping sendPrompt/i, /already in progress/i, /type_busy/i];

/** True when starting a model call now would race an in-flight execution:
 *  the caller must queue instead of starting concurrent work. */
export function isExecutionOverlapError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err && typeof (err as { name: unknown }).name === "string"
    ? (err as { name: string }).name
    : "";
  if (name === "SpinDispatchAdmissionError") return "code" in err && err.code === "type_busy";
  const message = err instanceof Error ? err.message : String(err);
  return OVERLAP_PATTERNS.some((re) => re.test(message));
}
