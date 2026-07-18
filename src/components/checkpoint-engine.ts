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
      // #1335 finding #2: feed the *measured* checkpoint + suffix size so the
      // compaction decision reflects the real stable prefix, not the budget.
      stableContextTokens: Math.ceil(view.estimatedTokens),
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
   *
   * #1335 findings #3 and #5: selection consumes `maxHistoryTokens` and
   * `minRecentTokens`, groups messages into complete durable turn units
   * (a user message with its assistant response and any tool exchange),
   * retains the minimum recent complete suffix, compacts only whole turns,
   * and derives `firstKeptMessageId` from the actual first suffix message ID
   * rather than `sourceEnd + 1`. Callers must pass durable abmind transcript
   * IDs (#1406 wires the live store).
   */
  async maybeCompact(
    chatId: string,
    messages: Array<{ id: number; role: string; content: string }>,
    budget: { maxHistoryTokens: number; minRecentTokens: number; reason: StableContextBudget["reason"]; activeModel: string },
  ): Promise<number> {
    if (messages.length < 2) return -1;

    const units = groupTurnUnits(messages);
    if (units.length < 2) return -1; // need at least one compactable turn + suffix

    const totalTokens = units.reduce((s, u) => s + u.tokens, 0);
    // maxHistoryTokens gate: if the real stable context already fits, there is
    // nothing to compact (unless explicitly requested). This is how the budget
    // is consumed rather than the old fixed 80% slice.
    if (budget.reason !== "manual" && budget.maxHistoryTokens > 0 && totalTokens <= budget.maxHistoryTokens) {
      return -1;
    }

    // Determine the minimum recent complete suffix: walk backward from the
    // newest unit, retaining whole turns until the recent token floor is met.
    // The trailing (possibly in-flight) unit is always retained.
    let suffixTokens = 0;
    let suffixUnitStart = units.length - 1;
    for (let u = units.length - 1; u >= 0; u--) {
      suffixTokens += units[u]!.tokens;
      suffixUnitStart = u;
      if (suffixTokens >= budget.minRecentTokens) break;
    }
    // If the entire conversation is the suffix, nothing is left to compact.
    if (suffixUnitStart <= 0) return -1;

    // Compact contiguous complete turns from the oldest. An incomplete leading
    // turn (no final assistant response) may not be checkpointed, so compact
    // only the contiguous complete prefix that precedes the suffix.
    let compactEndUnit = suffixUnitStart - 1;
    while (compactEndUnit >= 0 && !units[compactEndUnit]!.complete) compactEndUnit--;
    if (compactEndUnit < 0) return -1; // no complete turn eligible for compaction

    const sourceUnitSlice = units.slice(0, compactEndUnit + 1);
    // Source message range from durable IDs of the unit boundaries.
    const sourceStart = sourceUnitSlice[0]!.startId;
    const sourceEnd = sourceUnitSlice[sourceUnitSlice.length - 1]!.endId;
    // #1335 finding #5: firstKeptMessageId is the real first suffix message ID,
    // not sourceEnd + 1 (which assumed contiguous integer IDs).
    const firstKeptMessageId = units[suffixUnitStart]!.startId;

    const sourceMessages = messages.slice(sourceUnitSlice[0]!.startIdx, sourceUnitSlice[sourceUnitSlice.length - 1]!.endIdx + 1);
    if (sourceMessages.length < 2) return -1;
    const sourceText = sourceMessages.map(m => `${m.role}:${m.content}`).join("\n");
    const sourceTokens = Math.ceil(sourceText.length / 4);
    const sourceDigest = computeDigest(sourceText);

    const ptr = this.store.getActivePointer(chatId);
    const generation = ptr?.generation ?? 0;

    // Summarize
    const budget_tokens = Math.max(2000, Math.min(Math.floor(sourceTokens * 0.2), 12000));
    const priorContent = ptr ? this.store.getCheckpoint(ptr.checkpointId)?.content ?? "" : "";
    const summary = await this.summarize(sourceText, budget_tokens, priorContent);
    if (!summary || summary.trim().length === 0) return -1;

    const checkpointTokens = Math.ceil(summary.length / 4);
    const checkpointDigest = computeDigest(summary);
    if (checkpointTokens >= sourceTokens) return -1; // inflation guard

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

/** A durable conversational turn: one user message through its final
 *  assistant response (including any in-between tool exchange). #1335. */
interface TurnUnit {
  /** start index into the source message array (inclusive). */
  startIdx: number;
  /** end index into the source message array (inclusive). */
  endIdx: number;
  /** durable ID of the first message in the unit. */
  startId: number;
  /** durable ID of the last message in the unit. */
  endId: number;
  /** true when the unit ends with a final assistant message (answerable turn). */
  complete: boolean;
  /** estimated token weight of the whole unit. */
  tokens: number;
}

/** Group a flat message array into whole durable turn units. A unit starts at a
 *  `user` message (or the array head) and extends through the following
 *  assistant/tool messages up to the next `user`. It is complete iff its last
 *  message is an assistant message. #1335 finding #3. */
function groupTurnUnits(messages: Array<{ id: number; role: string; content: string }>): TurnUnit[] {
  const units: TurnUnit[] = [];
  let startIdx = 0;
  for (let i = 0; i < messages.length; i++) {
    const startsNewTurn = messages[i]!.role === "user" && i > startIdx;
    if (!startsNewTurn) continue;
    units.push(makeUnit(messages, startIdx, i - 1));
    startIdx = i;
  }
  if (startIdx < messages.length) {
    units.push(makeUnit(messages, startIdx, messages.length - 1));
  }
  return units;
}

function makeUnit(messages: Array<{ id: number; role: string; content: string }>, startIdx: number, endIdx: number): TurnUnit {
  let chars = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    chars += messages[i]!.content.length;
  }
  return {
    startIdx,
    endIdx,
    startId: messages[startIdx]!.id,
    endId: messages[endIdx]!.id,
    complete: messages[endIdx]!.role === "assistant",
    tokens: Math.ceil(chars / 4),
  };
}
