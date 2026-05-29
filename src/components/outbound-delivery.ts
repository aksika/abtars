/**
 * outbound-delivery.ts — Single funnel for all outbound messages.
 * Sanitizes tags, chunks long messages, routes to platform adapter.
 */
import type { PlatformAdapter, SendOpts } from "../types/platform.js";
import { sanitizeOutbound } from "./sanitize-outbound.js";

export class OutboundDelivery {
  constructor(private adapter: PlatformAdapter) {}

  async send(channelId: string, text: string, opts?: SendOpts): Promise<number | string | undefined> {
    const clean = sanitizeOutbound(text);
    if (!clean) return undefined;
    const chunks = this.adapter.chunkResponse(clean);
    let lastId: number | string | undefined;
    for (const chunk of chunks) {
      lastId = await this.adapter.sendMessage(channelId, chunk, opts);
    }
    return lastId;
  }

  async sendDocument(channelId: string, filePath: string, caption?: string, opts?: SendOpts): Promise<number | string | undefined> {
    const cleanCaption = caption ? sanitizeOutbound(caption) : undefined;
    if ("sendDocument" in this.adapter) {
      return (this.adapter as any).sendDocument(channelId, filePath, cleanCaption, opts);
    }
    return undefined;
  }
}
