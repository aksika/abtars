/**
 * Session memory — builds memory context block for post-compaction injection.
 * Reads recent extracted memories, daily summary, and active todos.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localDate } from "./env-utils.js";
import type Database from "better-sqlite3";

/** Build memory context block from DB + filesystem. */
export function buildMemoryContext(db: Database.Database | null, memoryDir: string): string {
  const parts: string[] = ["[MEMORY CONTEXT]"];

  // Recent extracted memories (last 5 by recency)
  if (db) {
    try {
      const rows = db.prepare(
        "SELECT content_en FROM extracted_memories ORDER BY created_at DESC LIMIT 5",
      ).all() as { content_en: string }[];
      if (rows.length > 0) {
        parts.push("\n## Key Memories");
        for (const r of rows) parts.push(`- ${r.content_en}`);
      }
    } catch { /* table may not exist */ }
  }

  // Today's daily summary
  const dailyDir = join(memoryDir, "daily");
  const today = localDate();
  const dailyPath = join(dailyDir, `daily_${today}.md`);
  if (existsSync(dailyPath)) {
    try {
      const content = readFileSync(dailyPath, "utf-8").trim();
      if (content) parts.push(`\n## Today's Summary\n${content}`);
    } catch { /* */ }
  }

  // Active todos
  const todoPath = join(memoryDir, "..", "todo.md");
  if (existsSync(todoPath)) {
    try {
      const lines = readFileSync(todoPath, "utf-8").split("\n").filter(l => l.startsWith("- [ ]")).slice(0, 10);
      if (lines.length > 0) {
        parts.push("\n## Active Tasks");
        parts.push(...lines);
      }
    } catch { /* */ }
  }

  return parts.length > 1 ? parts.join("\n") : "";
}
