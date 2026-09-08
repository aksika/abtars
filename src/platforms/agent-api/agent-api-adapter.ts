/**
 * agent-api-adapter.ts — A2A as a PlatformAdapter (#978, #1786).
 *
 * Lane-1 quick chat boundary: authenticated peer discussion turns answered
 * by a cardless Spin P turn (professor/main, oneshot transient, deny-all
 * tool policy, peer-scoped identity). No Kanban card, help contribution,
 * contract, or Orc run is created here — delegation stays in peer-help.
 */

import type { PlatformAdapter, PlatformCapabilities, InboundMessage, SendOpts } from "../../types/platform.js";
import { logInfo, logDebug } from "../../components/logger.js";
import { buildPolicy } from "../../components/tool-sandbox.js";

const TAG = "a2a-adapter";

export interface PeerChatTurn {
  /** Structured conversation, last message must be user. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Caller-owned absolute deadline (ms epoch). */
  deadlineAt?: number;
  /** Per-turn model timeout override. */
  timeoutMs?: number;
}

export class AgentApiAdapter implements PlatformAdapter {
  readonly name = "a2a" as const;
  readonly capabilities: PlatformCapabilities = { voice: false, reactions: false, typing: false, threads: false };
  readonly supportsStreaming = false;
  // #1786: one running chat turn per remote peer (both WS + HTTP ingress
  // share this guard). Independent peers remain independent.
  private runningChats = new Set<string>();

  async start(): Promise<void> {
    logInfo(TAG, "A2A platform adapter ready");
  }

  stop(): void {}

  authorize(_msg: InboundMessage): boolean {
    return true; // JWT already verified at HTTP layer
  }

  async sendMessage(_channelId: string, _text: string, _opts?: SendOpts): Promise<string | undefined> {
    return undefined; // Not used — chat responses return inline
  }

  chunkResponse(text: string): string[] {
    return [text];
  }

  /**
   * Shared lane-1 chat receiver (#1786). Called by authenticated HTTP ingress
   * and the WS `peer.chat.v1` boot handler with the already-authenticated
   * peer identity (socket/signature — never payload text).
   *
   * Cardless by construction: `prompt` (never `goal`), transient P session,
   * peer-scoped identity, deny-all tool policy. Only non-empty text succeeds;
   * every other outcome is an explicit failure and never schedules work.
   */
  async handlePeerChat(peerId: string, sessionId: string, turn: PeerChatTurn): Promise<string> {
    if (this.runningChats.has(peerId)) {
      throw new Error(`busy: chat already running with ${peerId}`);
    }
    this.runningChats.add(peerId);
    try {
      const lastUser = [...turn.messages].reverse().find(m => m.role === "user");
      if (!lastUser || lastUser.content.trim().length === 0) {
        throw new Error("invalid_request: no user turn to answer");
      }
      // Receiver-side bound: smaller of remaining caller deadline and the
      // lane default. Expire before dispatch, never after.
      const now = Date.now();
      const remaining = turn.deadlineAt !== undefined ? turn.deadlineAt - now : undefined;
      if (remaining !== undefined && remaining <= 0) {
        throw new Error("timeout: chat deadline already expired");
      }
      const timeoutMs = Math.min(turn.timeoutMs ?? 60_000, remaining ?? 60_000, 120_000);

      const { spin } = await import("../../components/spin.js");
      logDebug(TAG, `-> ${peerId}/${sessionId}: ${lastUser.content.slice(0, 100)}`);

      const { result, outcome } = await spin.spin({
        type: "P",
        // Cardless: prompt only — a goal would allocate a Kanban card.
        prompt: turn.messages.map(m => `${m.role === "user" ? "Peer" : "You"}: ${m.content}`).join("\n"),
        source: "peer",
        sourcePeer: peerId,
        // Peer-scoped identity: never the master user namespace, so no
        // owner history or personal memory can hydrate this turn.
        userId: `peer:${peerId}`,
        platform: "a2a",
        // Deny-all execution policy, enforced at schema presentation AND
        // tool dispatch via the shared Spin → transport boundary.
        tools: buildPolicy("peer"),
        timeoutMs,
        deadlineAt: turn.deadlineAt,
        settlementOwner: "spin",
        await: true,
      });

      // #1651 v2: a peer request succeeds only for real text content. Never
      // fabricate a success payload for a silent turn.
      if (outcome !== "text" || result.trim().length === 0) {
        const reason = outcome === "no_reply"
          ? "model signalled no reply"
          : outcome === "reaction"
            ? "model returned only a reaction"
            : outcome === "text"
              ? "model returned empty text"
              : "model returned no output";
        throw new Error(`empty_response: ${reason}`);
      }

      logDebug(TAG, `<- ${peerId}/${sessionId}: ${result.slice(0, 100)}`);
      return result;
    } finally {
      this.runningChats.delete(peerId);
    }
  }

  /**
   * Legacy single-text entry (#978 compat). Preserved for the HTTP
   * `/v1/chat/completions` path; routes into the shared P receiver.
   */
  async handlePeerMessage(peerId: string, sessionId: string, text: string, timeoutMs = 300_000): Promise<string> {
    return this.handlePeerChat(peerId, sessionId, {
      messages: [{ role: "user", content: text }],
      timeoutMs: Math.min(timeoutMs, 120_000),
    });
  }
}
