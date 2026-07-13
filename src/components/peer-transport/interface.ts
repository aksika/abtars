/**
 * peer-transport/interface.ts — PeerTransport abstraction (#911/#1357).
 */

// #1358 — Remote Pi lifecycle and control types
import type {
  RemotePiEventV1,
  RemotePiEventsListRequestV1,
  RemotePiEventsListResponseV1,
  RemotePiEventsAckRequestV1,
  RemotePiEventsAckResponseV1,
  RemotePiControlRequestV1,
  RemotePiControlResponseV1,
} from "./remote-pi-types.js";

export interface PeerHealth {
  name: string;
  lastSeen: number;
  load: number;
  sessions: number;
  capabilities: string[];
  version: string;
  alive: boolean;
}

export interface PeerCard {
  name: string;
  host: string;
  port: number;
  capabilities?: string[];
}

export interface PeerMessage {
  type: "task" | "check" | "terminate" | "ask";
  payload: Record<string, unknown>;
}

export interface TaskResult {
  taskId: number;
  status: "queued" | "running" | "done" | "failed";
  result?: string;
  error?: string;
  tokensUsed?: number;
  workerResult?: Record<string, unknown>;
}

/**
 * #1357 — Discriminated Pi execution target for remote delegation.
 */
export interface RemotePiTargetV1 {
  executor: "pi";
  workspace_alias: string;
  model?: {
    provider: string;
    model_id: string;
    thinking?: string;
  };
  delivery?: "commit_push" | "patch_artifact" | "leave_remote";
}

export interface PeerDelegateResult {
  taskId: number;
  remoteSessionId?: string;
  /** #1357 — Present when executor === "pi" on the response. */
  runId?: string;
  generation?: number;
  executor?: "agent" | "pi";
}

export interface PeerTransport {
  send(peer: string, message: PeerMessage): Promise<unknown>;
  broadcast(message: PeerMessage): Promise<void>;
  discover(): PeerCard[];
  onMessage(handler: (from: string, message: PeerMessage) => void): void;

  /** Delegate a task to a remote peer. Returns remote identifiers. */
  delegateTask(peer: string, goal: string, opts?: {
    priority?: string;
    context?: string;
    artifacts?: Array<{ name: string; content: string }>;
    contract?: Record<string, unknown>;
    attemptId?: string;
    /** #1357 — Typed Pi execution target. */
    target?: RemotePiTargetV1;
    /** #1357 — Origin-generated request ID for idempotency. */
    requestId?: string;
  }): Promise<PeerDelegateResult>;

  checkTask(peer: string, taskId: number): Promise<TaskResult>;
  terminateTask(peer: string, taskId: number): Promise<void>;
  pushChannelMessage(peer: string, cardId: number, from: string, message: string, createdAt: string): Promise<void>;

  // #1358 — Remote Pi lifecycle and control methods

  /** Push a lifecycle event to a peer via WSS. */
  pushLifecycleEvent(peer: string, event: RemotePiEventV1): Promise<void>;

  /** List events for a remote Pi run (catch-up). */
  listRemotePiEvents(peer: string, request: RemotePiEventsListRequestV1): Promise<RemotePiEventsListResponseV1>;

  /** Acknowledge events for a remote Pi run. */
  acknowledgeRemotePiEvents(peer: string, request: RemotePiEventsAckRequestV1): Promise<RemotePiEventsAckResponseV1>;

  /** Send a control command to a remote Pi run. */
  sendRemotePiControl(peer: string, request: RemotePiControlRequestV1): Promise<RemotePiControlResponseV1>;
}
