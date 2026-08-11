import { logTrace } from "./logger.js";

const MAX_FIELD_LEN = 200;
const MAX_SERIALIZED = 4000;

export interface SwarmTraceEvent {
  event: string;
  project?: number;
  card?: number;
  attempt?: string;
  generation?: number;
  executor?: string;
  from?: string;
  to?: string;
  reviewCase?: string;
  decision?: string;
  reason?: string;
}

function cap(s: string | undefined | null, max: number): string | undefined {
  if (s == null) return undefined;
  const normalized = String(s).replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length > max) return normalized.slice(0, max) + "...";
  return normalized;
}

export function logSwarmTrace(event: SwarmTraceEvent): void {
  const safeEvent: Record<string, unknown> = { event: cap(event.event, MAX_FIELD_LEN) ?? "unknown" };
  if (event.project != null && event.project > 0) safeEvent.project = event.project;
  if (event.card != null && event.card > 0) safeEvent.card = event.card;
  if (event.attempt != null) safeEvent.attempt = cap(event.attempt, MAX_FIELD_LEN);
  if (event.generation != null && event.generation >= 0) safeEvent.generation = event.generation;
  if (event.executor != null) safeEvent.executor = cap(event.executor, MAX_FIELD_LEN);
  if (event.from != null) safeEvent.from = cap(event.from, MAX_FIELD_LEN);
  if (event.to != null) safeEvent.to = cap(event.to, MAX_FIELD_LEN);
  if (event.reviewCase != null) safeEvent.reviewCase = cap(event.reviewCase, MAX_FIELD_LEN);
  if (event.decision != null) safeEvent.decision = cap(event.decision, MAX_FIELD_LEN);
  if (event.reason != null) safeEvent.reason = cap(event.reason, MAX_FIELD_LEN);
  let serialized = JSON.stringify(safeEvent);
  if (serialized.length > MAX_SERIALIZED) {
    safeEvent._truncated = true;
    serialized = JSON.stringify(safeEvent);
    if (serialized.length > MAX_SERIALIZED) {
      serialized = serialized.slice(0, MAX_SERIALIZED) + ',"_truncated":true}';
    }
  }
  logTrace("swarm-trace", serialized);
}
