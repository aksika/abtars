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
  async handlePeerMessage(peerId: string, sessionId: string, text: string, timeoutMs = 300_000): Promise<string> {
    const { spin } = await import("../../components/spin.js");

    logDebug(TAG, `-> ${peerId}/${sessionId}: ${text.slice(0, 100)}`);

    const { result, outcome } = await spin.dispatchAwait({
      type: "O",
      goal: `[PEER REQUEST from ${peerId}] ${text}`,
      title: `peer:${peerId}`,
      source: "peer",
      timeoutMs,
      settlementOwner: "spin",
    });

    // #1651 v2: a peer request succeeds only for real text content. Never
    // fabricate a success payload for a silent turn — the error reaches the
    // existing HTTP error boundary with a stable code.
    if (outcome !== "text") {
      const reason = outcome === "no_reply"
        ? "model signalled no reply"
        : outcome === "reaction"
          ? "model returned only a reaction"
          : "model returned no output";
      throw new Error(`empty_model_response: ${reason}`);
    }

    logDebug(TAG, `<- ${peerId}/${sessionId}: ${result.slice(0, 100)}`);
    return result;
  }
}
