import type { Platform } from "../types/index.js";

const TELEGRAM_MAX_LENGTH = 4096;
const DISCORD_MAX_LENGTH = 2000;

/** Characters that must be escaped in Telegram MarkdownV2. */
const MARKDOWN_V2_ESCAPE = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

/**
 * Collects streaming ACP response chunks and formats them
 * for Telegram delivery (chunking, Markdown conversion).
 */
export class ResponseFormatter {
  private buffers = new Map<string, string[]>();

  /** Accumulate a chunk for a session. */
  collectChunk(sessionId: string, chunk: string): void {
    const existing = this.buffers.get(sessionId);
    if (existing) {
      existing.push(chunk);
    } else {
      this.buffers.set(sessionId, [chunk]);
    }
  }

  /** Flush accumulated chunks for a session, returning Telegram-ready messages. */
  flush(sessionId: string): string[] {
    const chunks = this.buffers.get(sessionId);
    this.buffers.delete(sessionId);
    if (!chunks || chunks.length === 0) return [];
    const full = chunks.join("");
    return this.chunkText(full);
  }

  /** Split text into chunks that fit Telegram's 4096-char limit. */
  chunkText(text: string): string[] {
    if (text.length <= TELEGRAM_MAX_LENGTH) {
      return [text];
    }

    const result: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= TELEGRAM_MAX_LENGTH) {
        result.push(remaining);
        break;
      }

      // Try to split at paragraph boundary
      let splitAt = remaining.lastIndexOf("\n\n", TELEGRAM_MAX_LENGTH);
      if (splitAt <= 0) {
        // Try single newline
        splitAt = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
      }
      if (splitAt <= 0) {
        // Try space
        splitAt = remaining.lastIndexOf(" ", TELEGRAM_MAX_LENGTH);
      }
      if (splitAt <= 0) {
        // Hard split
        splitAt = TELEGRAM_MAX_LENGTH;
      }

      result.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return result;
  }

  /** Escape text for Telegram MarkdownV2 parse mode. */
  toTelegramMarkdown(markdown: string): string {
    // Preserve code blocks — don't escape inside them
    const parts = markdown.split(/(```[\s\S]*?```|`[^`]+`)/);
    return parts
      .map((part, i) => {
        // Odd indices are code blocks/inline code — leave as-is
        if (i % 2 === 1) return part;
        return part.replace(MARKDOWN_V2_ESCAPE, "\\$1");
      })
      .join("");
  }

  /** Split text into chunks for Discord's 2000-char limit.
   *  Respects paragraph and code block boundaries — never splits inside a fenced code block. */
  chunkTextForDiscord(text: string): string[] {
    if (text.length <= DISCORD_MAX_LENGTH) {
      return [text];
    }

    const result: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= DISCORD_MAX_LENGTH) {
        result.push(remaining);
        break;
      }

      // Check if there's an open code block in the window we're about to cut
      const window = remaining.slice(0, DISCORD_MAX_LENGTH);
      const fenceMatches = window.match(/```/g);
      const hasOpenCodeBlock = fenceMatches != null && fenceMatches.length % 2 !== 0;

      if (hasOpenCodeBlock) {
        // Find the start of the open code block (last unmatched ```)
        const lastFenceIdx = window.lastIndexOf("```");
        // Try to split before the code block at a paragraph boundary
        let splitAt = remaining.lastIndexOf("\n\n", lastFenceIdx);
        if (splitAt <= 0) {
          splitAt = remaining.lastIndexOf("\n", lastFenceIdx);
        }
        if (splitAt <= 0) {
          // Can't avoid splitting inside the code block — close and reopen
          splitAt = remaining.lastIndexOf("\n", DISCORD_MAX_LENGTH - 4); // leave room for closing ```
          if (splitAt <= 0) {
            splitAt = DISCORD_MAX_LENGTH - 4;
          }
          // Find the code fence language specifier for reopening
          const fenceStart = remaining.lastIndexOf("```", splitAt);
          const fenceLine = remaining.slice(fenceStart, remaining.indexOf("\n", fenceStart));
          result.push(remaining.slice(0, splitAt) + "\n```");
          remaining = fenceLine + "\n" + remaining.slice(splitAt).trimStart();
          continue;
        }
        result.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
        continue;
      }

      // No open code block — split normally at paragraph/line boundaries
      let splitAt = remaining.lastIndexOf("\n\n", DISCORD_MAX_LENGTH);
      if (splitAt <= 0) {
        splitAt = remaining.lastIndexOf("\n", DISCORD_MAX_LENGTH);
      }
      if (splitAt <= 0) {
        splitAt = remaining.lastIndexOf(" ", DISCORD_MAX_LENGTH);
      }
      if (splitAt <= 0) {
        splitAt = DISCORD_MAX_LENGTH;
      }

      result.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return result;
  }

  /** Split text for the appropriate platform. */
  chunkForPlatform(text: string, platform: Platform): string[] {
    if (platform === "discord") {
      return this.chunkTextForDiscord(text);
    }
    return this.chunkText(text);
  }

  /** Convert standard Markdown to Discord-compatible Markdown (mostly passthrough). */
  toDiscordMarkdown(text: string): string {
    return text;
  }

  /** Format a tool status update for the user. */
  formatToolStatus(toolName: string, status: "start" | "done" | "error"): string {
    switch (status) {
      case "start":
        return `🔧 ${toolName}...`;
      case "done":
        return `✅ ${toolName}`;
      case "error":
        return `❌ ${toolName} failed`;
    }
  }
}
