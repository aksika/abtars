/**
 * checkpoint-engine.ts — #1335 checkpoint selection, generation, and
 * stable context assembly.
 *
 * Coordinates abmind's CheckpointStore with abtars's reserve calculation
 * and LLM summarization to produce cache-stable context views.
 */

import type { CheckpointStore, StableContextView, StableContextBudget } from "abmind";
import { calculateReserve, estimateTokensFromChars } from "./transport/token-budget.js";
import type { ContextReserveInput } from "./transport/token-budget.js";

export interface CheckpointEngineConfig {
  checkpointStore: CheckpointStore;
  summarize: (serializedTurns: string, budget: number, priorCheckpoint: string) => Promise<string>;
  promptVersion: string;
  serializerVersion: string;
}

export class CheckpointEngine {
  private store: CheckpointStore;
  private summarize: CheckpointEngineConfig["summarize"];
  private promptVersion: string;
  private serializerVersion: string;

  constructor(config: CheckpointEngineConfig) {
    this.store = config.checkpointStore;
    this.summarize = config.summarize;
    this.promptVersion = config.promptVersion;
    this.serializerVersion = config.serializerVersion;
  }

  /**
   * Build the stable context view for a Direct API request.
   * Assembles: stable system/tools → active checkpoint → verbatim suffix →
   * volatile context → raw current user → in-flight tool exchanges.
   */
  async buildStableView(
    chatId: string,
    systemPrompt: string,
    toolSchemas: unknown[],
    rawMessages: Array<{ id: number; role: string; content: string }>,
    volatileContext: Array<{ kind: string; content: string }>,
    currentUserText: string,
    inFlightUnits: Array<{ role: string; content: string }>,
    beforeMessageId?: number,
    contextWindow?: number,
    clampedMaxOutput?: number,
    recentGrowth?: number[],
  ): Promise<{
    view: StableContextView;
    reserve: ReturnType<typeof calculateReserve>;
    messages: Array<{ role: string; content: string }>;
  }> {
    // Get the stable checkpoint view from abmind
    const view = this.store.getStableContext(chatId, rawMessages, { beforeMessageId });

    // Calculate reserve for the active candidate
    const reserveInput: ContextReserveInput = {
      contextWindow: contextWindow ?? 128_000,
      configuredMaxOutput: clampedMaxOutput ?? 4096,
      clampedMaxOutput: clampedMaxOutput ?? 4096,
      safetyMargin: 4096,
      stableSystemTokens: estimateTokensFromChars(systemPrompt.length),
      toolSchemaTokens: estimateTokensFromChars(JSON.stringify(toolSchemas).length),
      volatileContextTokens: volatileContext.reduce((s, v) => s + estimateTokensFromChars(v.content.length), 0),
      currentTurnTokens: estimateTokensFromChars(currentUserText.length),
      inFlightTokens: inFlightUnits.reduce((s, u) => s + estimateTokensFromChars(u.content.length), 0),
      recentAtomicGrowthTokens: recentGrowth ?? [],
    };
    const reserve = calculateReserve(reserveInput);

    // Assemble messages in cache-stable order:
    // 1. Stable system + tool contract
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
    ];

    // 2. Active cumulative checkpoint (if any)
    if (view.checkpoint) {
      messages.push({ role: "system", content: `[Checkpoint — ${view.checkpoint.digest}]\n${view.checkpoint.content}` });
    }

    // 3. Verbatim recent suffix
    for (const m of view.messages) {
      messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: "system", content: "[End of cacheable historical prefix]" });

    // 4. Volatile per-turn context
    for (const vc of volatileContext) {
      messages.push({ role: "system", content: `[${vc.kind}]\n${vc.content}` });
    }

    // 5. Raw current user turn
    messages.push({ role: "user", content: currentUserText });

    // 6. In-flight tool exchanges
    for (const u of inFlightUnits) {
      messages.push(u);
    }

    return { view, reserve, messages };
  }

  /**
   * Select and generate a checkpoint when headroom requires compaction.
   * Returns the new checkpoint ID, or -1 if no compaction was needed or CAS failed.
   */
  async maybeCompact(
    chatId: string,
    messages: Array<{ id: number; role: string; content: string }>,
    budget: { maxHistoryTokens: number; minRecentTokens: number; reason: StableContextBudget["reason"]; activeModel: string },
  ): Promise<number> {
    const ptr = this.store.getActivePointer(chatId);
    const generation = ptr?.generation ?? 0;

    // Find the eligible checkpoint chunk: oldest contiguous complete turns
    const eligibleEnd = messages.length - Math.max(1, Math.floor(messages.length * 0.2));
    if (eligibleEnd <= 0) return -1;

    const sourceMessages = messages.slice(0, eligibleEnd);
    if (sourceMessages.length < 2) return -1;

    const sourceStart = sourceMessages[0]!.id;
    const sourceEnd = sourceMessages[sourceMessages.length - 1]!.id;
    const sourceText = sourceMessages.map(m => `${m.role}:${m.content}`).join("\n");
    const sourceTokens = Math.ceil(sourceText.length / 4);
    const sourceDigest = computeDigest(sourceText);

    // Summarize
    const budget_tokens = Math.max(2000, Math.min(Math.floor(sourceTokens * 0.2), 12000));
    const priorContent = ptr ? this.store.getCheckpoint(ptr.checkpointId)?.content ?? "" : "";
    const summary = await this.summarize(sourceText, budget_tokens, priorContent);
    if (!summary || summary.trim().length === 0) return -1;

    const checkpointTokens = Math.ceil(summary.length / 4);
    const checkpointDigest = computeDigest(summary);
    if (checkpointTokens >= sourceTokens) return -1; // inflation guard

    const firstKeptMessageId = sourceEnd + 1;

    // Atomically commit
    return this.store.commitCheckpoint(chatId, {
      previousCheckpointId: ptr?.checkpointId ?? null,
      sourceMessageStart: sourceStart,
      sourceMessageEnd: sourceEnd,
      firstKeptMessageId,
      content: summary,
      sourceTokenCount: sourceTokens,
      checkpointTokenCount: checkpointTokens,
      sourceDigest,
      checkpointDigest,
      summarizerModel: null,
      summarizerProvider: null,
      activeRequestModel: budget.activeModel,
      reason: budget.reason,
      budgetJson: JSON.stringify(budget),
      classification: 1,
      promptVersion: this.promptVersion,
      schemaVersion: 1,
      serializerVersion: this.serializerVersion,
    }, generation);
  }

  /** Reset checkpoint lineage for a session. */
  reset(chatId: string): void {
    this.store.resetCheckpoints(chatId);
  }
}

import { createHash } from "node:crypto";

function computeDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
