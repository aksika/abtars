/**
 * agent-api-adapter.ts — A2A as a PlatformAdapter (#978).
 *
 * Thin adapter: receives peer chat messages via HTTP, routes through
 * the shared message pipeline (same as Telegram/Discord). Spin owns sessions.
 * Response buffered via Promise — resolved when sendMessage() is called by pipeline.
 */

import type { PlatformAdapter, PlatformCapabilities, InboundMessage, SendOpts } from "../../types/platform.js";
import type { PipelineDeps } from "../../components/message-pipeline.js";
import { logInfo, logDebug } from "../../components/logger.js";

const TAG = "a2a-adapter";

export type ResponseResolver = { resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> };

export class AgentApiAdapter implements PlatformAdapter {
  readonly name = "a2a" as const;
  readonly capabilities: PlatformCapabilities = { voice: false, reactions: false, typing: false, threads: false };
  readonly supportsStreaming = false;

  private pipeline: PipelineDeps | null = null;
  private pending = new Map<string, ResponseResolver>();

  setPipeline(deps: PipelineDeps): void {
    this.pipeline = deps;
  }

  async start(): Promise<void> {
    logInfo(TAG, "A2A platform adapter ready");
  }

  stop(): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve(""); }
    this.pending.clear();
  }

  authorize(_msg: InboundMessage): boolean {
    return true; // JWT already verified at HTTP layer before reaching adapter
  }

  async sendMessage(channelId: string, text: string, _opts?: SendOpts): Promise<string | undefined> {
    const resolver = this.pending.get(channelId);
    if (resolver) {
      clearTimeout(resolver.timer);
      this.pending.delete(channelId);
      resolver.resolve(text);
    }
    return undefined;
  }

  chunkResponse(text: string): string[] {
    return [text]; // No chunking for A2A — return full response
  }

  /**
   * Process a peer chat message through the pipeline.
   * Returns the response text (resolved when pipeline calls sendMessage).
   */
  async handlePeerMessage(peerId: string, sessionId: string, text: string, timeoutMs = 60_000): Promise<string> {
    if (!this.pipeline) throw new Error("Pipeline not wired");

    const channelId = `${peerId}:${sessionId}`;

    const responsePromise = new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(channelId);
        resolve("[timeout — no response within 60s]");
      }, timeoutMs);
      this.pending.set(channelId, { resolve, timer });
    });

    const msg: InboundMessage = {
      platform: "a2a",
      channelId,
      userId: peerId,
      senderId: peerId,
      senderName: peerId,
      text,
      timestamp: Date.now(),
      isGroup: false,
      isVoice: false,
    };

    logDebug(TAG, `-> ${peerId}/${sessionId}: ${text.slice(0, 100)}`);

    // Fire into pipeline — same path as Telegram/Discord messages
    const { handleInboundMessage } = await import("../../components/message-pipeline.js");
    handleInboundMessage(msg, this, this.pipeline);

    const response = await responsePromise;
    logDebug(TAG, `<- ${peerId}/${sessionId}: ${response.slice(0, 100)}`);
    return response;
  }
}
