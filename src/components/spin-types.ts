/**
 * spin-types.ts — Types and helpers for the Spin session system (#943, #953).
 * Importable by any module that needs ManagedSession or SessionType without pulling in the full Spin class.
 */

import type { AgentName } from "./subagent-runtime.js";
import type { IKiroTransport, RuntimeUsageSnapshot } from "./transport/kiro-transport.js";
import type { SandboxPolicy } from "./tool-sandbox.js";
import { logError } from "./logger.js";

export type SessionType = "A" | "B" | "C" | "T" | "P" | "S" | "O" | "W" | "D" | "H";

export interface QueuedSessionInstruction {
  readonly id: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly source: "tui" | "platform" | "system";
  readonly text: string;
  readonly createdAt: number;
}

export type QueueInstructionResult =
  | { ok: true; instruction: QueuedSessionInstruction }
  | { ok: false; reason: "not_found" | "not_orc" | "not_busy" |
      "not_local" | "not_active" | "not_steerable" | "closing" |
      "stale_execution" | "too_large" | "queue_full" };

export type SteerEventType = "steer.queued" | "steer.consumed" | "steer.rejected" | "steer.expired" | "steer.failed";

export interface SteerEvent {
  type: SteerEventType;
  instructionIds: string[];
  sessionId: string;
  executionId: string;
  timestamp: number;
  description: string;
}

// ── #1248: Bounded /wait FIFO ─────────────────────────────────────────────────

export const MAX_WAIT_ITEMS = 20;
export const MAX_WAIT_ITEM_BYTES = 4 * 1024;
export const MAX_WAIT_TOTAL_BYTES = 32 * 1024;

export interface PendingWaitInstruction {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  readonly bytes: number;
}

export interface ManagedSession {
  id: string;                    // "1749563282_A_01"
  userId: string;
  platform: string;
  chatId: number;
  threadId?: number | string;

  // Transport
  transport?: IKiroTransport;
  transportOwner?: "bridge" | "runtime";
  releaseTransport?: () => Promise<void>;
  delivery: "streaming" | "simple";
  model?: string;
  provider?: string;
  pid?: number;
  peer?: string;                 // remote host name (hollow session)
  remoteSessionId?: string;      // session ID on the peer

  // Lifecycle
  active: boolean;               // true = current session for this userId+platform
  status: "creating" | "ready" | "paused" | "ended";
  idleTimeoutMs: number;
  lastActiveAt: number;
  motherId?: string;
  name?: string;

  // Context
  workingDir?: string;
  contextPercent?: number;

  // Metrics
  messageCount: number;
  tokenCount: number;
  /** Usage for the most recently completed sendPrompt turn, when reported. */
  lastTurnUsage?: RuntimeUsageSnapshot;
  /** In-memory usage total for this managed session. Not persisted. */
  sessionUsage?: RuntimeUsageSnapshot;
  toolCallCount: number;

  // Session event log (last 5 events)
  log: string[];

  // Display
  shortIndex: number;

  // Pipeline state (#1040 — merged from SessionRegistry)
  busy: boolean;
  queue: Array<{ msg: import("../types/platform.js").InboundMessage; adapter: import("../types/platform.js").PlatformAdapter }>;
  fullMode: boolean;
  pendingStart: boolean;
  seen: boolean;
  compacting: boolean;
  ctxWarned: boolean;
  compactFailures: number;
  primingTerms: string[];
  /** #1248: Bounded FIFO for /wait instructions (replaced unbounded string). */
  pendingWait: PendingWaitInstruction[];

  // Completion buffer (#1040 — merged from completion-buffer.ts)
  completions: Array<{ sessionId: string; goal: string; status: string; result: string; elapsedMs: number; inputTokens: number; outputTokens: number }>;

  // Session-scoped metadata (#1271). Set ONCE at session allocation from
  // `SpinSessionSpec.metadata`; never merged on `sessionId` reuse. Use
  // `onStepComplete`'s event for per-step data.
  metadata?: Record<string, unknown>;

  // #1332/#1361: Cooperative steering queue for any active execution
  instructionQueue: QueuedSessionInstruction[];
  activeExecutionId?: string;
  /** #1361: True while the current execution is accepting steering continuations. */
  steeringAccepting: boolean;

  // #1319: Orc activity correlation
  activeCardId?: number;
  activeRootCardId?: number;
}

export interface SpinRequest {
  type: SessionType;
  agent?: import("./subagent-runtime.js").AgentName; // override typeAgent() default
  goal: string;
  title?: string;
  executionControl?: import("./execution-control.js").WorkerExecutionControl;
  source: "task" | "user" | "agent" | "peer";
  cardId?: number;
  parentCardId?: number;
  deliveryMode?: "silent" | "deliver" | "announce";
  priority?: string;
  tools?: SandboxPolicy;
  timeoutMs?: number;
  callbackPeer?: string; // #675: peer to notify on completion
  sourcePeer?: string;   // #949: which peer delegated this task
  chatId?: string;      // #1008: delivery target chat (fallback: masterChatId)
  maxToolRounds?: number; // #1283: per-task circuit breaker override
  /** #1366: Worker acceptance contract (supervised dispatch). */
  contract?: import("./worker-contract.js").WorkerAcceptanceContractV1;
  /** #1366: Pre-allocated attempt ID for supervision correlation. */
  attemptId?: string;
}

// ── #1271: unified session API ──────────────────────────────────────────

export interface SpinSessionSpec {
  type: SessionType;

  // Identity
  userId?: string;          // default: master user
  platform?: string;        // default: "background"
  chatId?: number;          // default: 0

  // Work
  goal?: string;            // user-facing → creates kanban card
  prompt?: string;          // background one-shot → no card

  // Reuse / continuation (multi-step sleep, pipeline main turn)
  sessionId?: string;       // reuse an existing session (send next prompt to it)

  // Lifecycle overrides (default comes from the profile)
  active?: boolean;
  persistent?: boolean;
  terminateAfter?: "call" | "response" | "external";

  // Kanban tracking
  cardId?: number;
  parentCardId?: number;
  title?: string;
  priority?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  source?: "task" | "user" | "agent" | "peer";

  // Execution
  agent?: import("./subagent-runtime.js").AgentName; // override the profile's agent
  timeoutMs?: number;
  maxToolRounds?: number; // #1283: per-task circuit breaker override

  // Delivery (continuation / pipeline)
  deliveryMode?: "deliver" | "silent" | "announce";
  imageContent?: unknown;   // → sendPrompt arg 3 (image passthrough)
  callbackPeer?: string;
  sourcePeer?: string;
  // #1329: just-persisted raw user message ID (from BuildPromptResult.currentMessageId).
  // Carried through to DirectApiTransport.sendPrompt as the exclusive
  // `beforeMessageId` cursor so the augmented current turn is appended
  // exactly once. Undefined on no-write paths (memory disabled, etc.).
  currentMessageId?: number;
  /** #1335: structured current turn components for Direct API cache-stable assembly. */
  directContextTurn?: {
    rawUserText: string;
    volatileBlocks: ReadonlyArray<{ kind: string; content: string }>;
  };
  // NOTE: no `stream` field. Streaming is a transport property
  // (transport.onIntermediateResponse / onToolCallStart / onSegmentBreak) that the
  // PIPELINE sets before calling spin() and resets in its finally — Spin never touches it.
  // sendPrompt is (sessionKey, message, image?, context?: PromptRequestContext) — 4 args, no stream.

  // #1366: Worker supervision contract and attempt ID
  contractId?: string;
  attemptId?: string;
  // #1248: Execution control for cancellation
  executionControl?: import("./execution-control.js").WorkerExecutionControl;

  // Extension / future-proofing
  metadata?: Record<string, unknown>;  // session-scoped initial data, set ONCE at allocation
                                        // (not merged on sessionId-reuse — see design §2)

  // Result
  await?: boolean;

  // Progress hook (partial-result reporting — sleep, workers)
  onStepComplete?: (event: StepEvent) => void | Promise<void>;
}

export interface StepEvent {
  sessionId: string;
  cardId?: number;
  stepIndex: number;        // 1-based call count within this session
  result?: string;          // undefined on failure
  error?: Error;
  durationMs: number;
  inputTokens?: number;     // per-call absolute (usage.input), not a delta
  outputTokens?: number;    // per-call absolute (usage.output)
}

export interface SpinResult {
  sessionId: string;
  cardId?: number;
  result?: string;          // present when await: true
}

/** #1361: Per-execution continuation-capable driver for Spin's execution loop. */
export interface SpinExecutionDriver {
  send(prompt: string, image?: { mime: string; base64: string }, context?: import("./transport/kiro-transport.js").PromptRequestContext): Promise<string>;
  close(): Promise<void>;
  readonly ephemeral: boolean;
}

export interface DispatchBackgroundOptions {
  prompt: string;
  type?: SessionType;      // default "S" (ephemeral one-shot)
  agent?: import("./subagent-runtime.js").AgentName;  // override the profile agent
  timeoutMs?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function sessionType(session: ManagedSession): SessionType {
  const type = session.id.split("_")[1];
  if (!type) logError("spin-types", `Malformed session ID "${session.id}" — no type segment, defaulting to A`);
  return (type ?? "A") as SessionType;
}

/** Session type from a raw session-id string (companion to sessionType(session)). */
export function sessionTypeOf(sessionId: string): SessionType {
  return (sessionId.split("_")[1] ?? "A") as SessionType;
}

/**
 * #1022: compaction fires only for A (main) and C (coding) session types.
 * Every other type (B, D, O, S, T, P, W, H) is never compacted. Hard requirement.
 */
const COMPACTABLE_TYPES: ReadonlySet<SessionType> = new Set<SessionType>(["A", "C"]);
export function isCompactable(sessionId: string): boolean {
  return COMPACTABLE_TYPES.has(sessionTypeOf(sessionId));
}

export function sessionCreatedAt(session: ManagedSession): number {
  return parseInt(session.id.split("_")[0] ?? "0", 10) * 1000;
}

const TYPE_LABELS: Record<SessionType, string> = {
  A: "Main", B: "Browse", C: "Code", T: "Task", P: "Peer",
  S: "System", O: "Orc", W: "Worker", D: "Dreamy", H: "Healer",
};

const TYPE_AGENT_MAP: Partial<Record<SessionType, AgentName>> = {
  A: "professor", C: "coding", B: "browsie", D: "dreamy",
  O: "professor", T: "professor", W: "browsie", H: "coding",
};

export function typeLabel(t: SessionType): string { return TYPE_LABELS[t]; }

/** #1271: single source of truth = SessionProfile. Kept as fallback for callers
 *  that import spin-types without pulling in spin-profiles. */
export function typeAgent(t: SessionType): AgentName {
  try {
    // Lazy require to avoid circular import (spin-profiles → spin-types).
    // The static map is also kept for back-compat in the standalone abmind path.
    const { SESSION_PROFILES } = require("./spin-profiles.js") as typeof import("./spin-profiles.js");
    return SESSION_PROFILES[t].agent;
  } catch {
    return TYPE_AGENT_MAP[t] ?? "professor";
  }
}

export function parseSessionType(input: string): SessionType | null {
  switch (input.toLowerCase()) {
    case "browse": return "B";
    case "code": return "C";
    case "task": return "T";
    default: return null;
  }
}
