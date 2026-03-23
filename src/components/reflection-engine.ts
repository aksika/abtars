import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";

export type Reflection = {
  channelKey: string;
  date: string;
  content: string;
  preview: string;
  filePath: string;
};

const TIERS = ["daily", "weekly", "quarterly"] as const;

function parseFileTimestamp(tier: string, file: string): number {
  if (tier === "daily") {
    const m = file.match(/daily_(\d{4})-(\d{2})-(\d{2})\.md/);
    if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getTime();
  } else if (tier === "weekly") {
    const m = file.match(/weekly_(\d{4})-W(\d{2})\.md/);
    if (m) {
      const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
      const dow = jan4.getUTCDay() || 7;
      const w1 = new Date(jan4.getTime() - (dow - 1) * 86_400_000);
      return w1.getTime() + (Number(m[2]) - 1) * 7 * 86_400_000;
    }
  } else if (tier === "quarterly") {
    const m = file.match(/quarterly_(\d{4})-Q(\d)\.md/);
    if (m) return new Date(Date.UTC(Number(m[1]), (Number(m[2]) - 1) * 3, 1)).getTime();
  }
  return 0;
}

/**
 * Generates human-readable meta-summaries (reflections) from consolidation
 * files and recent conversations over a configurable time window.
 */
export class ReflectionEngine {
  readonly db: Database.Database;
  readonly config: MemoryConfig;

  constructor(db: Database.Database, config: MemoryConfig) {
    this.db = db;
    this.config = config;
  }

  async reflect(params: {
    channelKey: string;
    llmCall: (prompt: string, content: string) => Promise<string>;
    windowDays?: number;
  }): Promise<Reflection> {
    const { channelKey, llmCall, windowDays = 7 } = params;
    const now = Date.now();
    const windowStart = now - windowDays * 24 * 60 * 60 * 1000;

    // Load consolidation .md files in time window
    const consolidations: Array<{ content: string; timestamp: number }> = [];
    for (const tier of TIERS) {
      const dir = join(this.config.memoryDir, tier);
      try {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".md")) continue;
          const ts = parseFileTimestamp(tier, file);
          if (ts >= windowStart && ts <= now) {
            consolidations.push({ content: readFileSync(join(dir, file), "utf-8"), timestamp: ts });
          }
        }
      } catch { /* dir doesn't exist */ }
    }
    consolidations.sort((a, b) => a.timestamp - b.timestamp);

    const messages = this.db
      .prepare(
        `SELECT role, content, timestamp FROM messages
         WHERE chat_id = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
      )
      .all(channelKey, windowStart, now) as Array<{ role: string; content: string; timestamp: number }>;

    if (consolidations.length === 0 && messages.length === 0) {
      throw new Error("Insufficient data available for reflection");
    }

    const contentParts: string[] = [];
    if (consolidations.length > 0) {
      contentParts.push("## Consolidation Summaries\n");
      for (const c of consolidations) {
        contentParts.push(`### ${new Date(c.timestamp).toISOString().slice(0, 10)}\n${c.content}\n`);
      }
    }
    if (messages.length > 0) {
      contentParts.push("## Recent Conversations\n");
      for (const m of messages) contentParts.push(`[${m.role}] ${m.content}`);
    }

    const prompt =
      "Generate a human-readable weekly digest from the following memory data. " +
      "Organize the digest by topic clusters. Use clear markdown formatting with " +
      "headings for each topic. Write in natural-language prose. " +
      "Start with a one-line summary of the week.";

    const reflectionContent = await llmCall(prompt, contentParts.join("\n"));
    const firstLine = reflectionContent.split("\n").find((line) => line.trim().length > 0) ?? "";
    const preview = firstLine.replace(/^#+\s*/, "").trim();

    const dateStr = new Date(now).toISOString().slice(0, 10);
    const reflectionDir = join(this.config.memoryDir, "reflections", channelKey);
    mkdirSync(reflectionDir, { recursive: true });
    const filePath = join(reflectionDir, `${dateStr}.md`);
    writeFileSync(filePath, reflectionContent, "utf-8");

    return { channelKey, date: dateStr, content: reflectionContent, preview, filePath };
  }

  listReflections(channelKey: string): Array<{ date: string; preview: string }> {
    const reflectionDir = join(this.config.memoryDir, "reflections", channelKey);
    if (!existsSync(reflectionDir)) return [];

    const files = readdirSync(reflectionDir).filter((f) => f.endsWith(".md"));
    const results: Array<{ date: string; preview: string }> = [];
    for (const file of files) {
      const date = file.replace(/\.md$/, "");
      try {
        const content = readFileSync(join(reflectionDir, file), "utf-8");
        const firstLine = content.split("\n").find((line) => line.trim().length > 0) ?? "";
        results.push({ date, preview: firstLine.replace(/^#+\s*/, "").trim() });
      } catch {
        results.push({ date, preview: "(unable to read)" });
      }
    }
    return results.sort((a, b) => b.date.localeCompare(a.date));
  }
}
