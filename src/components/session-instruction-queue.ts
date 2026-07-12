import { logDebug } from "./logger.js";
import type { QueuedSessionInstruction, QueueInstructionResult, ManagedSession, SteerEvent, SteerEventType } from "./spin-types.js";
import { isHollow } from "./spin-sessions.js";

const TAG = "steer-queue";

const MAX_QUEUE_SIZE = 20;
const MAX_BYTES_PER_ITEM = 4 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;

let instructionSeq = 0;

/** #1362: Scoped multi-subscriber steering event bus. Replaces the singleton steerListener. */
interface SteerSub {
  filter: { sessionId: string; executionId?: string };
  listener: (event: SteerEvent) => void;
}
let steerSubs: SteerSub[] = [];

export function onSteerEvent(listener: (event: SteerEvent) => void): () => void {
  const sub: SteerSub = { filter: { sessionId: "" }, listener };
  steerSubs.push(sub);
  return () => { steerSubs = steerSubs.filter(s => s !== sub); };
}

/** #1362: Subscribe with a session/execution filter. Returns unsubscribe function. */
export function subscribeSteerEvents(
  filter: { sessionId: string; executionId?: string },
  listener: (event: SteerEvent) => void,
): () => void {
  const sub: SteerSub = { filter, listener };
  steerSubs.push(sub);
  return () => { steerSubs = steerSubs.filter(s => s !== sub); };
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
  for (const sub of steerSubs) {
    if (sub.filter.sessionId && sub.filter.sessionId !== event.sessionId) continue;
    if (sub.filter.executionId && sub.filter.executionId !== event.executionId) continue;
    try { sub.listener(event); } catch { /* swallow */ }
  }
}

/** #1361: Generalized validation — supports any local active steerable session. */
export function queueInstruction(
  session: ManagedSession,
  input: { text: string; source: QueuedSessionInstruction["source"] },
): QueueInstructionResult {
  // Reject hollow (remote) sessions
  if (session.peer || isHollow(session)) {
    return { ok: false, reason: "not_local" };
  }
  // Session must allow execution
  if (session.status === "ended") {
    return { ok: false, reason: "not_active" };
  }
  if (session.status === "paused") {
    return { ok: false, reason: "not_active" };
  }
  // Must have an active execution generation
  if (!session.activeExecutionId) {
    return { ok: false, reason: "stale_execution" };
  }
  // Acceptance gate must be open
  if (!session.steeringAccepting) {
    return { ok: false, reason: "not_steerable" };
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

/** #1361: Drain instructions matching the current execution generation only. */
export function drainInstructionBatch(session: ManagedSession): QueuedSessionInstruction[] {
  if (session.instructionQueue.length === 0) return [];

  // Filter to current generation only, expire stale ones
  const current = session.activeExecutionId;
  const stale: QueuedSessionInstruction[] = [];
  const fresh: QueuedSessionInstruction[] = [];
  for (const inst of session.instructionQueue) {
    if (inst.executionId === current) {
      fresh.push(inst);
    } else {
      stale.push(inst);
    }
  }
  if (stale.length > 0) {
    failInstructions(session, stale.map(i => i.id), "stale_generation");
  }

  if (fresh.length === 0) return [];

  session.instructionQueue = session.instructionQueue.filter(i => !fresh.includes(i));
  publish("steer.consumed", fresh.map(i => i.id), session, `batch of ${fresh.length}`);
  logDebug(TAG, `drained ${fresh.length} instructions from ${session.id}`);
  return fresh;
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
