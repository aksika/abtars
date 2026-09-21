/**
 * fast-path-answer.ts — #1813 thin abtars consumption of abmind verdicts.
 *
 * Two parts: a pure eligibility gate and a delivery path. The gate opens only
 * for an "answer" decision on an eligible Main turn; everything else flows to
 * the ordinary agent path. Delivery mirrors simple delivery (chunked send,
 * assistant memory record, compaction, metrics, settle) without touching the
 * streaming machinery, citation feedback, or watchdog/heartbeat behavior.
 */

import { logInfo, logDebug, logWarn } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { attemptMemoryMutation } from "../memory-runtime.js";
import { assistantMessageKey } from "../memory-operation-key.js";
import type { RuntimeRecallDecision, AbtarsMemoryRuntime } from "../memory-runtime.js";
import type { PlatformAdapter, DeliveryCorrelation } from "../../types/platform.js";

/** Retry a send operation on transient network errors (fetch failed, timeout, 5xx). */
export async function retrySend<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient = msg.includes("fetch failed") || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || /^5\d\d/.test(msg);
      if (!transient || i === attempts - 1) throw err;
      const delay = 1000 * Math.pow(3, i);
      logWarn("pipeline", `Delivery failed (attempt ${i + 1}/${attempts}), retrying in ${delay}ms: ${msg}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

export interface FastPathTurnShape {
  sessionType: string;
  skillIsolated: boolean;
  hasAttachment: boolean;
  voice: boolean;
}

/**
 * #1813 — eligibility for skipping model invocation. Every condition must
 * hold; any doubt returns null and the turn takes the ordinary agent path.
 * Deliberately conservative: Main (A) text turns only, no attachments, no
 * voice (TTS path), no skill-isolated sessions.
 */
export function fastPathAnswerText(
  decision: RuntimeRecallDecision | undefined,
  turn: FastPathTurnShape,
): string | null {
  if (!decision || decision.outcome !== "answer") return null;
  const text = decision.answerText?.trim() ?? "";
  if (text.length === 0 || decision.sourceIds.length === 0) return null;
  if (turn.sessionType !== "A") return null;
  if (turn.skillIsolated || turn.hasAttachment || turn.voice) return null;
  // Visible supporting evidence: the extract plus its memory references.
  // The extract itself is verbatim owner-side; only the ref line is added.
  return `${text}\n\n— memory #${decision.sourceIds.join(", #")}`;
}

export interface FastPathDeliveryDeps {
  adapter: PlatformAdapter;
  channelId: string;
  threadId?: string;
  deliveryCorrelation?: DeliveryCorrelation;
  recordAssistant?: {
    runtime: Pick<AbtarsMemoryRuntime, "recordMessage">;
    platform: string;
    userId: string;
    sessionId: string;
    guest: boolean;
  };
  onDelivered?: () => void;
}

/** A compaction trigger is eligible only after the assistant row has a
 * durable identity (mirrors message-pipeline's settlement rule). */
export function hasDurableFastPathId(
  result: { ok: true; value: unknown } | { ok: false },
): boolean {
  if (!result.ok || !result.value || typeof result.value !== "object") return false;
  return "id" in result.value && typeof (result.value as { id?: unknown }).id === "number";
}

/**
 * Deliver a fast-path answer through normal Main-owned delivery. Returns
 * delivery status; failures throw so the caller can fall back to the
 * ordinary path or settle not_sent. Citation feedback is untouched.
 */
export async function deliverFastPathAnswer(
  rendered: string,
  deps: FastPathDeliveryDeps,
): Promise<{ delivered: boolean; recorded: boolean }> {
  const { adapter, channelId } = deps;
  let sentAnyChunk = false;
  const chunks = adapter.chunkResponse(rendered);
  for (const chunk of chunks) {
    const clean = chunk.trim();
    if (!clean) continue;
    await retrySend(() => adapter.sendMessage(channelId, clean, {
      threadId: deps.threadId,
      deliveryCorrelation: deps.deliveryCorrelation,
    }));
    sentAnyChunk = true;
  }
  if (!sentAnyChunk) return { delivered: false, recorded: false };
  let recorded = false;
  const rec = deps.recordAssistant;
  if (rec && !rec.guest) {
    const timestamp = Date.now();
    const deliveryId = deps.deliveryCorrelation?.executionId ?? `${rec.sessionId}-${timestamp}`;
    const operationKey = assistantMessageKey(
      rec.platform, deps.channelId, deps.threadId,
      rec.userId, deliveryId,
    );
    try {
      const writeResult = await attemptMemoryMutation({
        phase: "after_delivery",
        family: "assistant",
        operationKey,
        run: () => rec.runtime.recordMessage({
          role: "assistant", content: rendered, timestamp,
          userId: rec.userId, sessionId: rec.sessionId,
        }, operationKey),
      });
      if (!hasDurableFastPathId(writeResult)) {
        logDebug("fastpath", "assistant record has no durable id — compaction skipped");
      } else {
        recorded = true;
      }
    } catch (err) {
      logAndSwallow("fastpath", "assistant record", err);
    }
  }
  deps.onDelivered?.();
  logInfo("fastpath", `Delivered fast-path answer (${rendered.length} chars)`);
  return { delivered: true, recorded };
}
