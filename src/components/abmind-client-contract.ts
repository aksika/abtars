/**
 * Structural client contract consumed by abtars memory runtime and sleep
 * wiring. Both the local abmind AbmindClient and the abtars-owned signed WSS
 * client satisfy it. Types are structural and deliberately independent of
 * any abmind package runtime import.
 */

import type {
  AbmindRouteSnapshotV1Like,
} from "./abmind-route-contract.js";

export type {
  AbmindRouteSnapshotV1Like, AbmindRouteStateLike,
  AbmindRouteReasonCodeLike,
} from "./abmind-route-contract.js";

export interface AbmindCapabilitiesLike {
  version: number;
  methods: string[];
  features: Record<string, unknown>;
}

export interface AbmindPrivateMemoryLike {
  instantStore(params: unknown, idempotencyKey?: string): Promise<unknown>;
  editMemory(params: unknown, idempotencyKey?: string): Promise<unknown>;
  recall(params: unknown): Promise<unknown>;
  rebuildFtsIndexes(): Promise<unknown>;
  embed(input: { texts: string[] }): Promise<unknown>;
  recordMessage(input: unknown, idempotencyKey?: string): Promise<unknown>;
  getRecentConversation(input: unknown): Promise<unknown>;
  assembleSessionContext(input: unknown): Promise<unknown>;
  getRuntimeStatus(input?: unknown): Promise<unknown>;
  getCoreKnowledge(input: unknown): Promise<unknown>;
  recordFeedback(input: unknown, idempotencyKey?: string): Promise<unknown>;
  /** #1527: daemon-owned durable context projection (private read). */
  projectConversationContext(input: unknown): Promise<unknown>;
  /** #1406: daemon-owned durable compaction prepare (private read). */
  prepareConversationCompaction(input: unknown): Promise<unknown>;
  /** #1406: daemon-owned durable compaction commit (private mutate). */
  commitConversationCompaction(input: unknown, idempotencyKey?: string): Promise<unknown>;
}

export interface SleepStartResultLike {
  status: string;
  runId?: string;
  reason?: string;
}

export interface SleepRuntimeNextLike {
  status: string;
  heartbeat?: true;
  completionRequest?: {
    completionId: string;
    runId: string;
    stepId: string;
    prompt: string;
    deadline: number;
  };
}

export interface SleepEventsResultLike {
  runId: string;
  events: Array<{ seq: number; at: number; event: { type: string; detail?: string } }>;
  nextSeq: number;
  gap: boolean;
  terminal: boolean;
}

export interface AbmindSleepRuntimeLike {
  open(providerInstanceId: string, idempotencyKey?: string): Promise<SleepStartResultLike & { leaseId?: string; expiresAt?: number }>;
  next(leaseId: string, waitMs?: number): Promise<SleepRuntimeNextLike>;
  complete(leaseId: string, completionId: string, text: string, idempotencyKey?: string): Promise<{ status: string }>;
  fail(leaseId: string, completionId: string, code: string, idempotencyKey?: string): Promise<{ status: string }>;
  close(leaseId: string, idempotencyKey?: string): Promise<{ status: string }>;
}

export interface SleepStatusLastLike {
  runId?: string;
  attemptedAt: number;
  finishedAt?: number;
  status: string;
  report?: string;
  resumable: boolean;
  completedSteps: number;
  failedSteps: number;
}

/** Structural shape of abmind's sleep.status output (#1603). */
export interface SleepStatusLike {
  state: "idle" | "running" | "terminal" | "interrupted";
  active?: { runId: string; mode: string; startedAt: number; step?: string; percent: number };
  last?: SleepStatusLastLike;
}

export interface AbmindSleepLike {
  start(mode: "scheduled" | "manual", level?: string, fresh?: boolean, idempotencyKey?: string): Promise<SleepStartResultLike>;
  status(): Promise<SleepStatusLike>;
  resume(runId?: string, level?: string, idempotencyKey?: string): Promise<SleepStartResultLike>;
  events(afterSeq: number, limit?: number, waitMs?: number): Promise<SleepEventsResultLike>;
  runtime: AbmindSleepRuntimeLike;
}

/**
 * The minimal structural client interface abtars consumes: capabilities,
 * route snapshot, private memory methods, sleep methods, and lifecycle. No
 * runtime import from the abmind package is required to satisfy it.
 */
export interface AbmindClientLike {
  readonly capabilities: AbmindCapabilitiesLike | null;
  readonly routeSnapshot: AbmindRouteSnapshotV1Like;
  /**
   * Bounded push notifications of route changes (diagnostics). Absent on
   * transports without a background route state machine (local Unix).
   */
  onRouteChange?(listener: (snapshot: AbmindRouteSnapshotV1Like) => void): () => void;
  readonly privateMemory: AbmindPrivateMemoryLike;
  readonly sleep: AbmindSleepLike;
  negotiate(): Promise<unknown>;
  close(): Promise<void>;
}
