/**
 * peer-transport/interface.ts — PeerTransport abstraction (#911).
 *
 * Unified interface for all peer-to-peer communication. Initial impl: HTTP.
 * Future: libp2p, GossipSub, etc. — swap implementation, same API.
 */

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
}

export interface PeerTransport {
  /** Send a message to a specific peer. */
  send(peer: string, message: PeerMessage): Promise<unknown>;

  /** Broadcast a message to all known peers. */
  broadcast(message: PeerMessage): Promise<void>;

  /** Discover available peers (static from peers.json for now). */
  discover(): PeerCard[];

  /** Register handler for incoming peer messages. */
  onMessage(handler: (from: string, message: PeerMessage) => void): void;

  /** Delegate a task to a remote peer. Returns remote cardId. */
  delegateTask(peer: string, goal: string, opts?: { priority?: string; context?: string }): Promise<number>;

  /** Check status of a remote task. */
  checkTask(peer: string, taskId: number): Promise<TaskResult>;

  /** Terminate a remote task. */
  terminateTask(peer: string, taskId: number): Promise<void>;
}
