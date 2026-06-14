/**
 * agent-api-adapter.ts — A2A as a PlatformAdapter (#978).
 *
 * Thin adapter: receives peer chat messages via HTTP, routes through
 * Spin → Orc. Peers don't get casual chat — they get orchestrated work.
 * Response buffered via Promise — resolved when Orc completes the card.
 */

import type { PlatformAdapter, PlatformCapabilities, InboundMessage, SendOpts } from "../../types/platform.js";
import { logInfo, logDebug } from "../../components/logger.js";

const TAG = "a2a-adapter";

export class AgentApiAdapter implements PlatformAdapter {
  readonly name = "a2a" as const;
  readonly capabilities: PlatformCapabilities = { voice: false, reactions: false, typing: false, threads: false };
  readonly supportsStreaming = false;

  async start(): Promise<void> {
    logInfo(TAG, "A2A platform adapter ready");
  }

  stop(): void {}

  authorize(_msg: InboundMessage): boolean {
    return true; // JWT already verified at HTTP layer
  }

  async sendMessage(_channelId: string, _text: string, _opts?: SendOpts): Promise<string | undefined> {
    return undefined; // Not used — response comes from Orc card result
  }

  chunkResponse(text: string): string[] {
    return [text];
  }

  /**
   * Process a peer chat message: route through Spin → Orc.
   * Returns the Orc's response (resolved when card completes).
   */
  async handlePeerMessage(peerId: string, sessionId: string, text: string, timeoutMs = 60_000): Promise<string> {
    const { spin } = await import("../../components/spin.js");
    const { kanbanGetCard } = await import("../../components/tasks/kanban-board.js");
    const { nerve } = await import("../../components/nerve.js");

    logDebug(TAG, `-> ${peerId}/${sessionId}: ${text.slice(0, 100)}`);

    // Dispatch through Spin → Orc handles the request
    const { cardId } = await spin.dispatchAwait({
      type: "O",
      goal: `[PEER REQUEST from ${peerId}] ${text}`,
      title: `peer:${peerId}`,
      source: "peer",
      timeoutMs,
    });

    const card = kanbanGetCard(cardId);
    const response = card?.result_summary || card?.error || "No response";

    logDebug(TAG, `<- ${peerId}/${sessionId}: ${response.slice(0, 100)}`);
    return response;
  }
}
