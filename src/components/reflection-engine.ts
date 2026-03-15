import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";

export type Reflection = {
  channelKey: string;
  date: string; // YYYY-MM-DD
  content: string; // markdown prose
  preview: string; // one-line summary
  filePath: string;
};

/**
 * Generates human-readable meta-summaries (reflections) from compacted
 * memories and recent conversations over a configurable time window.
 */
export class ReflectionEngine {
  readonly db: Database.Database;
  readonly config: MemoryConfig;

  constructor(db: Database.Database, config: MemoryConfig) {
    this.db = db;
    this.config = config;
  }

  /** Generate a reflection for the given channel over a time window. */
  async reflect(params: {
    channelKey: string;
    llmCall: (prompt: string, content: string) => Promise<string>;
    windowDays?: number;
  }): Promise<Reflection> {
    const { channelKey, llmCall, windowDays = 7 } = params;

    const now = Date.now();
    const windowStart = now - windowDays * 24 * 60 * 60 * 1000;

    // Query compacted memories within the time window
    const compactions = this.db
      .prepare(
        `SELECT summary, timestamp FROM compactions
         WHERE chat_id = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
      )
      .all(channelKey, windowStart, now) as Array<{
      summary: string;
      timestamp: number;
    }>;

    // Query recent messages within the time window
    const messages = this.db
      .prepare(
        `SELECT role, content, timestamp FROM messages
         WHERE chat_id = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
      )
      .all(channelKey, windowStart, now) as Array<{
      role: string;
      content: string;
      timestamp: number;
    }>;

    // If no data found, throw an informative error
    if (compactions.length === 0 && messages.length === 0) {
      throw new Error("Insufficient data available for reflection");
    }

    // Build content block from compacted summaries and recent messages
    const contentParts: string[] = [];

    if (compactions.length > 0) {
      contentParts.push("## Compacted Summaries\n");
      for (const c of compactions) {
        const dateStr = new Date(c.timestamp).toISOString().slice(0, 10);
        contentParts.push(`### ${dateStr}\n${c.summary}\n`);
      }
    }

    if (messages.length > 0) {
      contentParts.push("## Recent Conversations\n");
      for (const m of messages) {
        contentParts.push(`[${m.role}] ${m.content}`);
      }
    }

    const contentBlock = contentParts.join("\n");

    // Call LLM to generate a human-readable weekly digest organized by topic clusters
    const prompt =
      "Generate a human-readable weekly digest from the following memory data. " +
      "Organize the digest by topic clusters. Use clear markdown formatting with " +
      "headings for each topic. Write in natural-language prose. " +
      "Start with a one-line summary of the week.";

    const reflectionContent = await llmCall(prompt, contentBlock);

    // Extract the first line/sentence as the preview
    const firstLine = reflectionContent.split("\n").find((line) => line.trim().length > 0) ?? "";
    const preview = firstLine.replace(/^#+\s*/, "").trim();

    // Write the reflection to disk
    const dateStr = new Date(now).toISOString().slice(0, 10);
    const reflectionDir = join(this.config.memoryDir, "reflections", channelKey);
    mkdirSync(reflectionDir, { recursive: true });
    const filePath = join(reflectionDir, `${dateStr}.md`);
    writeFileSync(filePath, reflectionContent, "utf-8");

    return {
      channelKey,
      date: dateStr,
      content: reflectionContent,
      preview,
      filePath,
    };
  }

  /** List available reflections for a channel with dates and one-line previews. */
  listReflections(channelKey: string): Array<{ date: string; preview: string }> {
    const reflectionDir = join(this.config.memoryDir, "reflections", channelKey);

    if (!existsSync(reflectionDir)) {
      return [];
    }

    const files = readdirSync(reflectionDir).filter((f) => f.endsWith(".md"));
    const results: Array<{ date: string; preview: string }> = [];

    for (const file of files) {
      const date = file.replace(/\.md$/, "");
      const filePath = join(reflectionDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const firstLine = content.split("\n").find((line) => line.trim().length > 0) ?? "";
        const preview = firstLine.replace(/^#+\s*/, "").trim();
        results.push({ date, preview });
      } catch {
        // Skip files that can't be read
        results.push({ date, preview: "(unable to read)" });
      }
    }

    // Sort by date descending
    results.sort((a, b) => b.date.localeCompare(a.date));

    return results;
  }
}
