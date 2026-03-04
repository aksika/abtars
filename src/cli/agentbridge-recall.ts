#!/usr/bin/env node
/**
 * agentbridge-recall — standalone CLI for agent-initiated memory search.
 *
 * Kiro invokes this via shell tool when it needs to recall past conversations.
 * Opens the memory DB read-only and searches extracted memories + compactions.
 *
 * Usage:
 *   agentbridge-recall --keywords "kw1,kw2" --chat-id 7773842843
 *   agentbridge-recall --keywords "puppy" --original "kiskutya" --chat-id 7773842843
 *   agentbridge-recall --keywords "budget" --time-start 1700000000000 --time-end 1710000000000 --chat-id 7773842843
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DB_PATH = join(homedir(), ".agentbridge", "memory", "memory.db");
const MS_PER_DAY = 86_400_000;
const DECAY_HALFLIFE_DAYS = 14;
const RESULT_LIMIT = 10;

interface Result {
  content: string;
  source_timestamp: number;
  date: string;
  tier: string;
  score: number;
}

function parseArgs(): {
  keywords: string[];
  original?: string;
  timeStart?: number;
  timeEnd?: number;
  chatId: number;
} {
  const args = process.argv.slice(2);
  let keywords: string[] = [];
  let original: string | undefined;
  let timeStart: number | undefined;
  let timeEnd: number | undefined;
  let chatId = 0;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--keywords":
        keywords = (args[++i] ?? "").split(",").map((k) => k.trim()).filter(Boolean);
        break;
      case "--original":
        original = args[++i];
        break;
      case "--time-start":
        timeStart = parseInt(args[++i] ?? "", 10) || undefined;
        break;
      case "--time-end":
        timeEnd = parseInt(args[++i] ?? "", 10) || undefined;
        break;
      case "--chat-id":
        chatId = parseInt(args[++i] ?? "", 10) || 0;
        break;
    }
  }

  if (!keywords.length || !chatId) {
    console.error("Usage: agentbridge-recall --keywords \"kw1,kw2\" --chat-id <id> [--original <kw>] [--time-start <ms>] [--time-end <ms>]");
    process.exit(1);
  }

  return { keywords, original, timeStart, timeEnd, chatId };
}

function sanitizeFts(query: string): string {
  // Remove FTS5 special chars, build OR-style prefix query
  const tokens = query
    .replace(/['"*(){}[\]:^~!@#$%&\\|<>=+\-/]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return "";
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

function search(db: Database.Database, params: ReturnType<typeof parseArgs>): Result[] {
  const results: Result[] = [];
  const now = Date.now();

  // 1. Search extracted memories (English FTS5)
  const ftsQuery = sanitizeFts(params.keywords.join(" "));
  if (ftsQuery) {
    const conditions = ["em.chat_id = ?"];
    const sqlParams: (string | number)[] = [params.chatId];

    if (params.timeStart) { conditions.push("em.source_timestamp >= ?"); sqlParams.push(params.timeStart); }
    if (params.timeEnd) { conditions.push("em.source_timestamp <= ?"); sqlParams.push(params.timeEnd); }

    const sql = `
      SELECT em.content_en, em.content_original, em.source_timestamp, em.memory_type,
             rank * -1 as score
      FROM extracted_memories_fts fts
      JOIN extracted_memories em ON em.id = fts.rowid
      WHERE fts.content_en MATCH ? AND ${conditions.join(" AND ")}
      ORDER BY score DESC LIMIT 20
    `;

    const rows = db.prepare(sql).all(ftsQuery, ...sqlParams) as Array<{
      content_en: string; content_original: string; source_timestamp: number;
      memory_type: string; score: number;
    }>;

    for (const row of rows) {
      const ageDays = (now - row.source_timestamp) / MS_PER_DAY;
      const decayedScore = row.score * Math.pow(2, -ageDays / DECAY_HALFLIFE_DAYS);
      results.push({
        content: row.content_original || row.content_en,
        source_timestamp: row.source_timestamp,
        date: new Date(row.source_timestamp).toISOString(),
        tier: `extracted:${row.memory_type}`,
        score: decayedScore,
      });
    }
  }

  // 2. Search compactions (LIKE matching on summaries)
  {
    const conditions = ["chat_id = ?", "tier IN ('daily', 'weekly', 'quarterly')"];
    const sqlParams: (string | number)[] = [params.chatId];

    if (params.timeStart) { conditions.push("timestamp >= ?"); sqlParams.push(params.timeStart); }
    if (params.timeEnd) { conditions.push("timestamp <= ?"); sqlParams.push(params.timeEnd); }

    const likeClauses = params.keywords.map((kw) => {
      const escaped = kw.replace(/%/g, "\\%").replace(/_/g, "\\_");
      sqlParams.push(`%${escaped}%`);
      return "summary LIKE ? ESCAPE '\\'";
    });
    conditions.push(`(${likeClauses.join(" OR ")})`);

    const sql = `
      SELECT tier, timestamp, summary FROM compactions
      WHERE ${conditions.join(" AND ")}
      ORDER BY timestamp DESC LIMIT 10
    `;

    const rows = db.prepare(sql).all(...sqlParams) as Array<{
      tier: string; timestamp: number; summary: string;
    }>;

    for (const row of rows) {
      const ageDays = (now - row.timestamp) / MS_PER_DAY;
      const decayedScore = 1.0 * Math.pow(2, -ageDays / DECAY_HALFLIFE_DAYS);
      results.push({
        content: row.summary,
        source_timestamp: row.timestamp,
        date: new Date(row.timestamp).toISOString(),
        tier: row.tier,
        score: decayedScore,
      });
    }
  }

  // 3. Original-language fallback search
  if (params.original) {
    const escaped = params.original.replace(/%/g, "\\%").replace(/_/g, "\\_");
    const conditions = ["chat_id = ?", "content_original LIKE ? ESCAPE '\\\\'"];
    const sqlParams: (string | number)[] = [params.chatId, `%${escaped}%`];

    if (params.timeStart) { conditions.push("source_timestamp >= ?"); sqlParams.push(params.timeStart); }
    if (params.timeEnd) { conditions.push("source_timestamp <= ?"); sqlParams.push(params.timeEnd); }

    const sql = `
      SELECT content_original, content_en, source_timestamp, memory_type
      FROM extracted_memories
      WHERE ${conditions.join(" AND ")}
      ORDER BY source_timestamp DESC LIMIT 10
    `;

    const rows = db.prepare(sql).all(...sqlParams) as Array<{
      content_original: string; content_en: string; source_timestamp: number; memory_type: string;
    }>;

    for (const row of rows) {
      // Deduplicate against existing results
      if (results.some((r) => r.source_timestamp === row.source_timestamp && r.content === (row.content_original || row.content_en))) continue;
      const ageDays = (now - row.source_timestamp) / MS_PER_DAY;
      const decayedScore = 0.8 * Math.pow(2, -ageDays / DECAY_HALFLIFE_DAYS);
      results.push({
        content: row.content_original || row.content_en,
        source_timestamp: row.source_timestamp,
        date: new Date(row.source_timestamp).toISOString(),
        tier: `extracted:${row.memory_type}`,
        score: decayedScore,
      });
    }
  }

  // 4. Raw messages fallback (when extracted_memories is empty)
  if (results.length === 0) {
    const allKeywords = [...params.keywords];
    if (params.original) allKeywords.push(params.original);

    const conditions = ["chat_id = ?"];
    const sqlParams: (string | number)[] = [params.chatId];

    if (params.timeStart) { conditions.push("timestamp >= ?"); sqlParams.push(params.timeStart); }
    if (params.timeEnd) { conditions.push("timestamp <= ?"); sqlParams.push(params.timeEnd); }

    const likeClauses = allKeywords.map((kw) => {
      const escaped = kw.replace(/%/g, "\\%").replace(/_/g, "\\_");
      sqlParams.push(`%${escaped}%`);
      return "content LIKE ? ESCAPE '\\'";
    });
    conditions.push(`(${likeClauses.join(" OR ")})`);

    const sql = `
      SELECT role, content, timestamp FROM messages
      WHERE ${conditions.join(" AND ")}
      ORDER BY timestamp DESC LIMIT 20
    `;

    const rows = db.prepare(sql).all(...sqlParams) as Array<{
      role: string; content: string; timestamp: number;
    }>;

    for (const row of rows) {
      const ageDays = (now - row.timestamp) / MS_PER_DAY;
      const decayedScore = 0.5 * Math.pow(2, -ageDays / DECAY_HALFLIFE_DAYS);
      results.push({
        content: `[${row.role}] ${row.content}`,
        source_timestamp: row.timestamp,
        date: new Date(row.timestamp).toISOString(),
        tier: "raw_message",
        score: decayedScore,
      });
    }
  }

  // Sort by score descending, limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, RESULT_LIMIT);
}

// ── Main ──

const params = parseArgs();

if (!existsSync(DB_PATH)) {
  console.error(`Memory database not found: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
try {
  const results = search(db, params);
  console.log(JSON.stringify(results, null, 2));
} finally {
  db.close();
}
