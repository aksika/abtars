import { logDebug } from "./logger.js";
import type { QueuedSessionInstruction, QueueInstructionResult, ManagedSession, SteerEvent, SteerEventType } from "./spin-types.js";

const TAG = "steer-queue";

const MAX_QUEUE_SIZE = 20;
const MAX_BYTES_PER_ITEM = 4 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;

let instructionSeq = 0;

let steerListener: ((event: SteerEvent) => void) | null = null;

export function onSteerEvent(listener: (event: SteerEvent) => void): void {
  steerListener = listener;
}

function publish(type: SteerEventType, instructionIds: string[], session: ManagedSession, description: string): void {
  const event: SteerEvent = {
    type,
    instructionIds,
    sessionId: session.id,
    executionId: session.activeExecutionId ?? "",
    timestamp: Date.now(),
    description: description.slice(0, 200),
  };
  steerListener?.(event);
}

export function queueInstruction(
  session: ManagedSession,
  input: { text: string; source: QueuedSessionInstruction["source"] },
): QueueInstructionResult {
  if (!session.id.includes("_O_")) {
    return { ok: false, reason: "not_orc" };
  }
  if (!session.busy) {
    return { ok: false, reason: "not_busy" };
  }
  if (!session.activeExecutionId) {
    return { ok: false, reason: "stale_execution" };
  }

  if (Buffer.byteLength(input.text, "utf-8") > MAX_BYTES_PER_ITEM) {
    return { ok: false, reason: "too_large" };
  }

  const currentTextBytes = session.instructionQueue.reduce(
    (sum, i) => sum + Buffer.byteLength(i.text, "utf-8"), 0,
  );
  if (currentTextBytes + Buffer.byteLength(input.text, "utf-8") > MAX_TOTAL_BYTES) {
    return { ok: false, reason: "queue_full" };
  }

  if (session.instructionQueue.length >= MAX_QUEUE_SIZE) {
    return { ok: false, reason: "queue_full" };
  }

  const id = `steer_${Date.now()}_${++instructionSeq}`;
  const instruction: QueuedSessionInstruction = {
    id,
    sessionId: session.id,
    executionId: session.activeExecutionId,
    source: input.source,
    text: input.text,
    createdAt: Date.now(),
  };

  session.instructionQueue.push(instruction);
  publish("steer.queued", [id], session, input.text);
  logDebug(TAG, `queued ${id} for ${session.id}`);
  return { ok: true, instruction };
}

export function drainInstructionBatch(session: ManagedSession): QueuedSessionInstruction[] {
  if (session.instructionQueue.length === 0) return [];

  const batch = session.instructionQueue.splice(0);
  publish("steer.consumed", batch.map(i => i.id), session, `batch of ${batch.length}`);
  logDebug(TAG, `drained ${batch.length} instructions from ${session.id}`);
  return batch;
}

export function expireInstructions(session: ManagedSession, reason: string): void {
  if (session.instructionQueue.length === 0) return;
  const ids = session.instructionQueue.map(i => i.id);
  session.instructionQueue = [];
  publish("steer.expired", ids, session, reason);
  logDebug(TAG, `expired ${ids.length} instructions from ${session.id}: ${reason}`);
}

export function failInstructions(session: ManagedSession, ids: string[], reason: string): void {
  if (ids.length === 0) return;
  publish("steer.failed", ids, session, reason);
  logDebug(TAG, `failed ${ids.length} instructions from ${session.id}: ${reason}`);
}
