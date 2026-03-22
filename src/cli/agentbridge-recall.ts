#!/usr/bin/env node
/**
 * agentbridge-recall — standalone CLI for agent-initiated memory search.
 *
 * 7-stage cascade, extracted-first:
 *   1. extracted_memories_fts (EN, Darwinism-boosted)
 *   2. extracted_memories_original_fts (original language, Darwinism-boosted)
 *   3. messages_fts (relaxed OR)
 *   4. Consolidation file search (daily/weekly/quarterly .md)
 *   5. messages LIKE (wide net fallback)
 *   6-7. Keyword-free fallback (exclusive): recent messages OR latest daily summary
 *        — whichever is fresher wins, based on context-window-start boundary
 *
 * Short-circuit: if stages 1+2 yield ≥10 results, skip 3-7.
 *
 * Usage:
 *   agentbridge-recall --keywords "kw1,kw2" --chat-id 7773842843
 *   agentbridge-recall --keywords "puppy" --original "kiskutya" --chat-id 7773842843
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MemoryIndex } from "../components/memory-index.js";
import { searchConsolidationFiles, getLatestConsolidationFile } from "../components/consolidation-search.js";
import type { SearchResult, MemorySearchResult } from "../types/memory.js";

const MEMORY_DIR = join(homedir(), ".agentbridge", "memory");
const DB_PATH = join(MEMORY_DIR, "memory.db");
const CTX_START_PATH = join(MEMORY_DIR, "context-window-start.json");
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SHORT_CIRCUIT_THRESHOLD = 10;

/** Read context-window-start timestamp for a given chatId. Returns 0 if unknown. */
function readCtxStart(chatId: number): number {
  try {
    const data = JSON.parse(readFileSync(CTX_START_PATH, "utf-8")) as Record<string, number>;
    return data[String(chatId)] ?? 0;
  } catch { return 0; }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let keywords: string[] = [];
  let original: string | undefined;
  let timeStart: number | undefined;
  let timeEnd: number | undefined;
  let chatId = 0;
  let limit = DEFAULT_LIMIT;
  let maxClassification = 2;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--keywords": keywords = (args[++i] ?? "").split(",").map(k => k.trim()).filter(Boolean); break;
      case "--original": original = args[++i]; break;
      case "--time-start": timeStart = parseInt(args[++i] ?? "", 10) || undefined; break;
      case "--time-end": timeEnd = parseInt(args[++i] ?? "", 10) || undefined; break;
      case "--chat-id": chatId = parseInt(args[++i] ?? "", 10) || 0; break;
      case "--limit": limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(args[++i] ?? "", 10) || DEFAULT_LIMIT)); break;
      case "--max-classification": maxClassification = Math.min(2, Math.max(0, parseInt(args[++i] ?? "", 10))); break;
    }
  }

  if (!keywords.length || !chatId) {
    console.error("Usage: agentbridge-recall --keywords \"kw1,kw2\" --chat-id <id> [--original <kw>] [--limit <N>] [--time-start <ms>] [--time-end <ms>]");
    process.exit(1);
  }
  return { keywords, original, timeStart, timeEnd, chatId, limit, maxClassification };
}

if (!existsSync(DB_PATH)) {
  console.error(`Memory database not found: ${DB_PATH}`);
  process.exit(1);
}

const params = parseArgs();
const db = new Database(DB_PATH);

// Register strip_emojis for FTS5 delete trigger compatibility (content=messages table)
db.function("strip_emojis", (text: unknown) => {
  if (typeof text !== "string") return text;
  return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").replace(/ {2,}/g, " ").trim();
});

try {
  const index = new MemoryIndex(db);
  const searchOpts = { chatId: params.chatId, startTime: params.timeStart, endTime: params.timeEnd, limit: params.limit * 3, maxClassification: params.maxClassification };
  const query = params.keywords.join(" ");

  type Out = { content: string; date: string; source: string; score: number; source_ids?: string };
  const results: Out[] = [];
  const seen = new Set<string>();
  const extractedIds: number[] = [];

  const addExtracted = (r: MemorySearchResult, source: string) => {
    const key = `${r.source_timestamp}:${r.content.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (r.id !== undefined) extractedIds.push(r.id);
    results.push({ content: r.content, date: new Date(r.source_timestamp).toISOString(), source, score: r.score, ...(r.source_message_ids ? { source_ids: r.source_message_ids } : {}) });
  };

  const addMessage = (r: SearchResult, source: string) => {
    const key = `${r.record.timestamp}:${r.record.content.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ content: `[${r.record.role}] ${r.record.content}`, date: new Date(r.record.timestamp).toISOString(), source, score: r.score });
  };

  // --- Stage 1: Extracted memories — English FTS5 (Darwinism-boosted) ---
  for (const r of index.searchExtracted(query, searchOpts)) addExtracted(r, "extracted");

  // --- Stage 2: Extracted memories — original language FTS5 ---
  if (params.original) {
    for (const r of index.searchOriginal(params.original, { chatId: params.chatId, limit: params.limit * 3, maxClassification: params.maxClassification })) addExtracted(r, "extracted:original");
  }

  // Short-circuit: if extracted memories have enough results, skip fallback stages
  const shortCircuit = results.length >= SHORT_CIRCUIT_THRESHOLD;

  if (!shortCircuit) {
    // --- Stage 3: messages_fts (relaxed OR) ---
    if (query.trim()) {
      for (const r of index.search(query, searchOpts, "or")) addMessage(r, "messages_fts");
    }

    // --- Stage 4: Consolidation file search ---
    const allKw = [...params.keywords];
    if (params.original) allKw.push(params.original);
    const consolidationResults = searchConsolidationFiles(MEMORY_DIR, allKw, {
      startTime: params.timeStart,
      endTime: params.timeEnd,
    });
    for (const c of consolidationResults) {
      const key = `${c.timestamp}:${c.content.slice(0, 80)}`;
      if (!seen.has(key)) { seen.add(key); results.push({ content: c.content, date: new Date(c.timestamp).toISOString(), source: `consolidation:${c.tier}`, score: 0.5 }); }
    }

    // --- Stage 5: messages LIKE (wide net fallback) ---
    if (results.length < params.limit) {
      const allKwLike = [...params.keywords];
      if (params.original) allKwLike.push(params.original);
      const conditions = ["chat_id = ?"];
      const bindParams: (string | number)[] = [params.chatId];
      if (params.timeStart) { conditions.push("timestamp >= ?"); bindParams.push(params.timeStart); }
      if (params.timeEnd) { conditions.push("timestamp <= ?"); bindParams.push(params.timeEnd); }
      conditions.push(`(${allKwLike.map(kw => { bindParams.push(`%${kw}%`); return "content LIKE ?"; }).join(" OR ")})`);
      const rows = db.prepare(`SELECT role, content, timestamp FROM messages WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT 20`).all(...bindParams) as Array<{ role: string; content: string; timestamp: number }>;
      for (const r of rows) {
        const key = `${r.timestamp}:${r.content.slice(0, 80)}`;
        if (!seen.has(key)) { seen.add(key); results.push({ content: `[${r.role}] ${r.content}`, date: new Date(r.timestamp).toISOString(), source: "messages_like", score: 0.3 }); }
      }
    }

    // --- Stages 6/7: Keyword-free fallback (exclusive — fresher source wins) ---
    if (results.length === 0) {
      const ctxStart = readCtxStart(params.chatId);

      // Candidate A: recent messages before context window start
      const recentRows = db.prepare(
        `SELECT role, content, timestamp FROM messages WHERE chat_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`
      ).all(params.chatId, ctxStart || Date.now(), params.limit) as Array<{ role: string; content: string; timestamp: number }>;
      const recentTs = recentRows[0]?.timestamp ?? 0;

      // Candidate B: latest daily summary
      const dailySummary = getLatestConsolidationFile(MEMORY_DIR, "daily");
      const dailyTs = dailySummary?.timestamp ?? 0;

      if (dailyTs > recentTs && dailySummary) {
        // Daily summary is fresher — inject it only
        const key = `${dailySummary.timestamp}:${dailySummary.content.slice(0, 80)}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ content: dailySummary.content, date: new Date(dailySummary.timestamp).toISOString(), source: "fallback:daily_summary", score: 0.1 });
        }
        console.error("Fallback: injected latest daily summary (fresher than recent messages)");
      } else if (recentRows.length > 0) {
        // Recent messages are fresher — inject them only
        for (const r of recentRows) {
          const key = `${r.timestamp}:${r.content.slice(0, 80)}`;
          if (!seen.has(key)) { seen.add(key); results.push({ content: `[${r.role}] ${r.content}`, date: new Date(r.timestamp).toISOString(), source: "fallback:recent", score: 0.1 }); }
        }
        console.error(`Fallback: injected ${recentRows.length} recent messages (fresher than daily summary)`);
      }
    }
  }

  results.sort((a, b) => b.score - a.score);

  // Darwinism: bump recall count for extracted memories that made it into results
  index.bumpRecallCount(extractedIds);

  const output = results.slice(0, params.limit);
  console.log(JSON.stringify(output, null, 2));

  // Expand hint: if any results have source_ids, tell the agent how to look them up
  const expandable = output.filter(r => r.source_ids);
  if (expandable.length) {
    const allIds = expandable.map(r => r.source_ids).join(",");
    console.error(`\nHint: ${expandable.length} result(s) have source message IDs. Expand with:\n  agentbridge-expand --ids ${allIds}`);
  }
} finally {
  db.close();
}
