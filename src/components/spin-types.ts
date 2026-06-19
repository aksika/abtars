/**
 * spin-types.ts — Types and helpers for the Spin session system (#943, #953).
 * Importable by any module that needs ManagedSession or SessionType without pulling in the full Spin class.
 */

import type { AgentName } from "./subagent-runtime.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { SandboxPolicy } from "./tool-sandbox.js";
import { logError } from "./logger.js";

export type SessionType = "A" | "B" | "C" | "T" | "P" | "S" | "O" | "W" | "D" | "H";

export interface ManagedSession {
  id: string;                    // "1749563282_A_01"
  userId: string;
  platform: string;
  chatId: number;
  threadId?: number | string;

  // Transport
  transport?: IKiroTransport;
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
  pendingWait?: string;

  // Completion buffer (#1040 — merged from completion-buffer.ts)
  completions: Array<{ sessionId: string; goal: string; status: string; result: string; elapsedMs: number; inputTokens: number; outputTokens: number }>;
}

export interface SpinRequest {
  type: SessionType;
  agent?: import("./subagent-runtime.js").AgentName; // override typeAgent() default
  goal: string;
  title?: string;
  source: "task" | "user" | "agent" | "peer";
  cardId?: number;
  parentCardId?: number;
  deliveryMode?: "silent" | "announce";
  priority?: string;
  tools?: SandboxPolicy;
  timeoutMs?: number;
  callbackPeer?: string; // #675: peer to notify on completion
  sourcePeer?: string;   // #949: which peer delegated this task
  chatId?: string;      // #1008: delivery target chat (fallback: masterChatId)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function sessionType(session: ManagedSession): SessionType {
  const type = session.id.split("_")[1];
  if (!type) logError("spin-types", `Malformed session ID "${session.id}" — no type segment, defaulting to A`);
  return (type ?? "A") as SessionType;
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

export function typeAgent(t: SessionType): AgentName { return TYPE_AGENT_MAP[t] ?? "professor"; }

export function parseSessionType(input: string): SessionType | null {
  switch (input.toLowerCase()) {
    case "browse": return "B";
    case "code": return "C";
    case "task": return "T";
    default: return null;
  }
}
