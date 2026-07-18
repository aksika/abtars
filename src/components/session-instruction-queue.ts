import { logDebug } from "./logger.js";
import type { QueuedSessionInstruction, QueueInstructionResult, ManagedSession, SteerEvent, SteerEventType, InstructionLease, ExecutionInstructionKind } from "./spin-types.js";
import { isHollow } from "./spin-sessions.js";

const TAG = "steer-queue";

const MAX_QUEUE_SIZE = 20;
const MAX_BYTES_PER_ITEM = 4 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;

let instructionSeq = 0;
let leaseSeq = 0;

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

function publish(type: SteerEventType, instructionIds: string[], sessionId: string, executionId: string, description: string): void {
  const event: SteerEvent = {
    type,
    instructionIds,
    sessionId,
    executionId,
    timestamp: Date.now(),
    description: description.slice(0, 200),
  };
  for (const sub of steerSubs) {
    if (sub.filter.sessionId && sub.filter.sessionId !== event.sessionId) continue;
    if (sub.filter.executionId && sub.filter.executionId !== event.executionId) continue;
    try { sub.listener(event); } catch { /* swallow */ }
  }
}

function publishMultiGroup(records: QueuedSessionInstruction[], type: SteerEventType, sessionId: string, reason: string): void {
  const byGroup = new Map<string, QueuedSessionInstruction[]>();
  for (const rec of records) {
    const g = byGroup.get(rec.executionId);
    if (g) g.push(rec); else byGroup.set(rec.executionId, [rec]);
  }
  for (const [, group] of byGroup) {
    publish(type, group.map(i => i.id), sessionId, group[0]!.executionId, reason);
  }
}

function expireStaleInstructions(session: ManagedSession): void {
  const current = session.activeExecutionId;
  const stale = session.instructionQueue.filter(i => i.executionId !== current && i.state !== "expired" && i.state !== "failed");
  if (stale.length === 0) return;
  for (const inst of stale) {
    inst.state = "expired";
  }
  publishMultiGroup(stale, "steer.failed", session.id, "stale_generation");
  logDebug(TAG, `expired ${stale.length} stale instructions for ${session.id}`);
}

/** #1361: Generalized validation — supports any local active steerable session. */
export function queueInstruction(
  session: ManagedSession,
  input: { text: string; source: QueuedSessionInstruction["source"]; kind?: ExecutionInstructionKind },
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
  const bytes = Buffer.byteLength(input.text, "utf-8");
  const instruction: QueuedSessionInstruction = {
    id,
    sessionId: session.id,
    executionId: session.activeExecutionId,
    kind: input.kind ?? "steer",
    source: input.source,
    text: input.text,
    bytes,
    createdAt: Date.now(),
    state: "queued",
  };

  session.instructionQueue.push(instruction);
  publish("steer.queued", [id], session.id, instruction.executionId, input.text);
  logDebug(TAG, `queued ${id} for ${session.id}`);
  return { ok: true, instruction };
}

/**
 * #1444: Lease instructions for the current execution generation.
 * Marks matching entries as "leased" and returns a lease handle.
 * Stale (old generation) entries are expired first.
 */
export function leaseInstructions(
  session: ManagedSession,
  kind?: ExecutionInstructionKind,
): InstructionLease | null {
  if (session.instructionQueue.length === 0) return null;

  expireStaleInstructions(session);

  const current = session.activeExecutionId;
  if (!current) return null;

  const matching = session.instructionQueue.filter(
    i => i.executionId === current && i.state === "queued" && (!kind || i.kind === kind),
  );
  if (matching.length === 0) return null;

  const leaseId = `lease_${Date.now()}_${++leaseSeq}`;
  for (const inst of matching) {
    inst.state = "leased";
  }

  logDebug(TAG, `leased ${matching.length} instructions for ${session.id} (${leaseId})`);
  return {
    leaseId,
    sessionId: session.id,
    executionId: current,
    kind: kind ?? "steer",
    instructions: matching,
  };
}

/**
 * #1444: Mark leased instructions as delivered.
 * Call immediately before backend handoff (driver.send()).
 */
export function markDelivered(lease: InstructionLease): void {
  for (const inst of lease.instructions) {
    if (inst.state === "leased") {
      inst.state = "delivered";
    }
  }
  logDebug(TAG, `marked ${lease.instructions.length} instructions delivered for ${lease.sessionId} (${lease.leaseId})`);
}

/**
 * #1444: Mark delivered instructions as consumed (success).
 * Removes from queue and publishes steer.consumed.
 */
export function markConsumed(lease: InstructionLease, session: ManagedSession): void {
  const ids: string[] = [];
  for (const inst of lease.instructions) {
    if (inst.state === "delivered") {
      inst.state = "consumed";
      ids.push(inst.id);
    }
  }
  if (ids.length === 0) return;
  const consumed = new Set(ids);
  session.instructionQueue = session.instructionQueue.filter(i => !consumed.has(i.id));
  publish("steer.consumed", ids, lease.sessionId, lease.executionId, `batch of ${ids.length}`);
  logDebug(TAG, `consumed ${ids.length} instructions for ${lease.sessionId} (${lease.leaseId})`);
}

/**
 * #1444: Restore leased instructions to queued (abort before handoff).
 */
export function restoreBeforeDelivery(lease: InstructionLease): void {
  const ids: string[] = [];
  for (const inst of lease.instructions) {
    if (inst.state === "leased") {
      inst.state = "queued";
      ids.push(inst.id);
    }
  }
  if (ids.length > 0) {
    logDebug(TAG, `restored ${ids.length} instructions for ${lease.sessionId} (${lease.leaseId})`);
  }
}

/**
 * #1444: Mark delivered instructions as failed (delivery uncertain after handoff).
 * Publishes steer.failed and removes from queue.
 */
export function failAfterDelivery(lease: InstructionLease, session: ManagedSession, reason: string): void {
  const ids: string[] = [];
  for (const inst of lease.instructions) {
    if (inst.state === "delivered") {
      inst.state = "failed";
      ids.push(inst.id);
    }
  }
  if (ids.length === 0) return;
  const failed = new Set(ids);
  session.instructionQueue = session.instructionQueue.filter(i => !failed.has(i.id));
  publish("steer.failed", ids, lease.sessionId, lease.executionId, reason);
  logDebug(TAG, `failed ${ids.length} instructions for ${lease.sessionId}: ${reason}`);
}

/**
 * #1361: Drain instructions matching the current execution generation only.
 * Legacy compat — delegates to leaseInstructions + markDelivered + emit consumed.
 * Prefer leaseInstructions() for new code.
 */
export function drainInstructionBatch(session: ManagedSession): QueuedSessionInstruction[] {
  const lease = leaseInstructions(session);
  if (!lease) return [];
  markDelivered(lease);
  const result = [...lease.instructions];
  // Legacy compat: publish consumed immediately and remove from queue
  for (const inst of result) {
    inst.state = "consumed";
  }
  const ids = result.map(i => i.id);
  const consumed = new Set(ids);
  const kept = session.instructionQueue.filter(i => !consumed.has(i.id));
  session.instructionQueue.length = 0;
  session.instructionQueue.push(...kept);
  publish("steer.consumed", ids, lease.sessionId, lease.executionId, `batch of ${ids.length}`);
  logDebug(TAG, `drained ${result.length} instructions from ${session.id}`);
  return result;
}

export function expireInstructions(session: ManagedSession, reason: string): void {
  if (session.instructionQueue.length === 0) return;
  const records = [...session.instructionQueue];
  for (const inst of records) {
    if (inst.state !== "expired" && inst.state !== "failed") {
      inst.state = "expired";
    }
  }
  session.instructionQueue = [];
  publishMultiGroup(records, "steer.expired", session.id, reason);
  logDebug(TAG, `expired ${records.length} instructions from ${session.id}: ${reason}`);
}

export function failInstructions(session: ManagedSession, ids: string[], reason: string): void {
  if (ids.length === 0) return;
  const records: QueuedSessionInstruction[] = [];
  for (const id of ids) {
    const rec = session.instructionQueue.find(i => i.id === id);
    if (rec) {
      if (rec.state !== "failed" && rec.state !== "expired") {
        rec.state = "failed";
      }
      records.push(rec);
    }
  }
  publishMultiGroup(records, "steer.failed", session.id, reason);
  logDebug(TAG, `failed ${ids.length} instructions from ${session.id}: ${reason}`);
}
