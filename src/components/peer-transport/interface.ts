/**
 * peer-transport/interface.ts — PeerTransport abstraction (#911).
 *
 * Unified interface for all peer-to-peer communication. Initial impl: HTTP.
 * Future: libp2p, GossipSub, etc. — swap implementation, same API.
 */

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
  delegateTask(peer: string, goal: string, opts?: { priority?: string; context?: string; artifacts?: Array<{ name: string; content: string }> }): Promise<{ taskId: number; remoteSessionId?: string }>;

  /** Check status of a remote task. */
  checkTask(peer: string, taskId: number): Promise<TaskResult>;

  /** Terminate a remote task. */
  terminateTask(peer: string, taskId: number): Promise<void>;

  /** #949: Push a channel message to a remote peer. */
  pushChannelMessage(peer: string, cardId: number, from: string, message: string, createdAt: string): Promise<void>;
}
