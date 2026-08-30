/**
 * session-control/durable-adapter.ts — abmind-owned durable conversation
 * compaction (#1406).
 *
 * Implements prepare → summarize → commit for one owner's durable A/C
 * conversation. Selection and CAS commit live in the abmind daemon; this
 * adapter only executes the bounded provider summarization in between.
 * A stale candidate or CAS miss performs no write and is reported truthfully.
 */

import type { AbtarsMemoryRuntime } from "../memory-runtime.js";
import type { ConversationCompactionSummarizer } from "../compact-summarizer.js";
import { estimateTokensFromChars } from "../transport/token-budget.js";
import { memoryOperationKey } from "../memory-operation-key.js";
import { createHash } from "node:crypto";
import type {
  SessionControlAdapter, SessionControlRequest, SessionControlResult,
} from "./types.js";

/** Production history budget consumed by automatic compaction. */
export const DURABLE_COMPACTION_MAX_HISTORY_TOKENS = 120_000;
/** Production minimum recent suffix retained by automatic compaction. */
export const DURABLE_COMPACTION_MIN_RECENT_TOKENS = 20_000;

export interface DurableCompactionAdapterDeps {
  runtime: AbtarsMemoryRuntime;
  summarizer: ConversationCompactionSummarizer;
  maxHistoryTokens?: number;
  minRecentTokens?: number;
}

export class DurableConversationCompactionAdapter
  implements SessionControlAdapter<{ kind: "durable_conversation"; principalId: string; sessionId: string; beforeMessageId?: number }> {
  readonly targetKind = "durable_conversation" as const;
  private readonly deps: DurableCompactionAdapterDeps;

  constructor(deps: DurableCompactionAdapterDeps) {
    this.deps = deps;
  }

  supports(request: SessionControlRequest): boolean {
    return request.kind === "compact";
  }

  async execute(
    target: { kind: "durable_conversation"; principalId: string; sessionId: string; beforeMessageId?: number },
    request: SessionControlRequest,
  ): Promise<SessionControlResult> {
    const { runtime, summarizer } = this.deps;
    const base = {
      targetKind: "durable_conversation" as const,
      tokensBefore: undefined as number | undefined,
      tokensAfter: undefined as number | undefined,
      generation: undefined as number | undefined,
      message: "",
    };

    if (!runtime.supports("compaction")) {
      return { ...base, status: "unsupported", message: "Durable compaction is not available" };
    }

    const prepare = await runtime.prepareConversationCompaction({
      userId: target.principalId,
      sessionId: target.sessionId,
      beforeMessageId: target.beforeMessageId,
      maxHistoryTokens: this.deps.maxHistoryTokens ?? DURABLE_COMPACTION_MAX_HISTORY_TOKENS,
      minRecentTokens: this.deps.minRecentTokens ?? DURABLE_COMPACTION_MIN_RECENT_TOKENS,
      reason: request.reason,
    });

    if (prepare.status === "nothing_to_compact") {
      return { ...base, status: "nothing_to_compact", message: "Nothing to compact" };
    }
    if (prepare.status === "busy") {
      return { ...base, status: "busy", message: "Compaction already in progress" };
    }
    if (!prepare.candidate) {
      return { ...base, status: "failed", message: "Compaction candidate unavailable" };
    }
    const candidate = prepare.candidate;

    // Bounded provider summarization. Failure here performs no commit.
    const summary = await summarizer.summarize({
      serializedTurns: candidate.serializedTurns,
      priorCheckpoint: candidate.priorCheckpoint,
      maxOutputTokens: candidate.summaryTokenBudget,
      customInstructions: request.customInstructions,
      signal: request.signal,
    });

    const operationKey = memoryOperationKey("compact", [`${target.principalId}:${target.sessionId}:${candidate.expectedGeneration}`]);
    const commit = await runtime.commitConversationCompaction({
      userId: target.principalId,
      sessionId: target.sessionId,
      candidate: {
        version: 1,
        expectedGeneration: candidate.expectedGeneration,
        previousCheckpointId: candidate.previousCheckpointId,
        sourceMessageStart: candidate.sourceMessageStart,
        sourceMessageEnd: candidate.sourceMessageEnd,
        firstKeptMessageId: candidate.firstKeptMessageId,
        sourceDigest: candidate.sourceDigest,
        sourceTokenCount: candidate.sourceTokenCount,
      },
      summary: summary.text,
      summaryTokenCount: estimateTokensFromChars(summary.text.length),
      summarizer: { provider: summary.provider, model: summary.model },
      activeRequestModel: summary.model,
      reason: request.reason,
      customInstructionsDigest: request.customInstructions
        ? shortDigest(request.customInstructions)
        : undefined,
    }, operationKey);

    if (commit.status === "committed") {
      return {
        ...base,
        status: "completed",
        tokensBefore: candidate.sourceTokenCount,
        tokensAfter: estimateTokensFromChars(summary.text.length),
        generation: commit.generation,
        provider: summary.provider ?? undefined,
        model: summary.model ?? undefined,
        message: `Checkpoint ${commit.checkpointId} committed (generation ${commit.generation})`,
      };
    }
    if (commit.status === "stale") {
      return { ...base, status: "stale", message: "A newer checkpoint was committed first" };
    }
    return { ...base, status: "failed", message: "Checkpoint commit was rejected" };
  }
}

function shortDigest(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex").slice(0, 16);
}
