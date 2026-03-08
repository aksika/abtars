#!/usr/bin/env node
/**
 * agentbridge-recall — standalone CLI for agent-initiated memory search.
 *
 * Uses the existing MemoryIndex (FTS5 + substring) search pipeline.
 * Falls back through: FTS5 → substring LIKE → original-language → compaction LIKE.
 *
 * Usage:
 *   agentbridge-recall --keywords "kw1,kw2" --chat-id 7773842843
 *   agentbridge-recall --keywords "puppy" --original "kiskutya" --chat-id 7773842843
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MemoryIndex } from "../components/memory-index.js";
import type { SearchResult, MemorySearchResult } from "../types/memory.js";

const DB_PATH = join(homedir(), ".agentbridge", "memory", "memory.db");
const RESULT_LIMIT = 10;

function parseArgs() {
  const args = process.argv.slice(2);
  let keywords: string[] = [];
  let original: string | undefined;
  let timeStart: number | undefined;
  let timeEnd: number | undefined;
  let chatId = 0;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--keywords": keywords = (args[++i] ?? "").split(",").map(k => k.trim()).filter(Boolean); break;
      case "--original": original = args[++i]; break;
      case "--time-start": timeStart = parseInt(args[++i] ?? "", 10) || undefined; break;
      case "--time-end": timeEnd = parseInt(args[++i] ?? "", 10) || undefined; break;
      case "--chat-id": chatId = parseInt(args[++i] ?? "", 10) || 0; break;
    }
  }

  if (!keywords.length || !chatId) {
    console.error("Usage: agentbridge-recall --keywords \"kw1,kw2\" --chat-id <id> [--original <kw>] [--time-start <ms>] [--time-end <ms>]");
    process.exit(1);
  }
  return { keywords, original, timeStart, timeEnd, chatId };
}

if (!existsSync(DB_PATH)) {
  console.error(`Memory database not found: ${DB_PATH}`);
  process.exit(1);
}

const params = parseArgs();
const db = new Database(DB_PATH, { readonly: true });

try {
  const index = new MemoryIndex(db);
  const searchOpts = { chatId: params.chatId, startTime: params.timeStart, endTime: params.timeEnd, limit: RESULT_LIMIT * 3 };
  const query = params.keywords.join(" ");

  type Out = { content: string; date: string; source: string; score: number };
  const results: Out[] = [];
  const seen = new Set<string>();

  const add = (r: SearchResult, source: string) => {
    const key = `${r.record.timestamp}:${r.record.content.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ content: `[${r.record.role}] ${r.record.content}`, date: new Date(r.record.timestamp).toISOString(), source, score: r.score });
  };

  // Stage 1: FTS5
  for (const r of index.search(query, searchOpts)) add(r, "fts");

  // Stage 2: Relaxed FTS5 (OR-style, drops short tokens)
  if (results.length === 0) {
    const relaxed = query.split(/\s+/).filter(t => t.length >= 3).join(" OR ");
    if (relaxed && relaxed !== query) {
      for (const r of index.search(relaxed, searchOpts)) add(r, "relaxed");
    }
  }

  // Stage 3: Substring (accent-insensitive, catches compound words)
  for (const r of index.substringSearch(query, searchOpts)) add(r, "substring");

  // Stage 4: Original-language substring
  if (params.original && params.original !== query) {
    for (const r of index.substringSearch(params.original, searchOpts)) add(r, "original");
  }

  // Stage 5: Extracted memories — English (L2)
  const addExtracted = (r: MemorySearchResult, source: string) => {
    const key = `${r.source_timestamp}:${r.content.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ content: r.content, date: new Date(r.source_timestamp).toISOString(), source, score: r.score });
  };

  for (const r of index.searchExtracted(query, searchOpts)) addExtracted(r, "extracted");

  // Stage 6: Extracted memories — original language (L4)
  if (params.original) {
    for (const r of index.searchOriginal(params.original, { chatId: params.chatId, limit: RESULT_LIMIT * 3 })) addExtracted(r, "extracted:original");
  }

  // Stage 7: Compaction summaries
  const allKw = [...params.keywords];
  if (params.original) allKw.push(params.original);
  const conditions = ["chat_id = ?"];
  const sqlParams: (string | number)[] = [params.chatId];
  if (params.timeStart) { conditions.push("timestamp >= ?"); sqlParams.push(params.timeStart); }
  if (params.timeEnd) { conditions.push("timestamp <= ?"); sqlParams.push(params.timeEnd); }
  conditions.push(`(${allKw.map(kw => { sqlParams.push(`%${kw}%`); return "summary LIKE ?"; }).join(" OR ")})`);
  const compactions = db.prepare(`SELECT tier, timestamp, summary FROM compactions WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT 10`).all(...sqlParams) as Array<{ tier: string; timestamp: number; summary: string }>;
  for (const c of compactions) {
    const key = `${c.timestamp}:${c.summary.slice(0, 80)}`;
    if (!seen.has(key)) { seen.add(key); results.push({ content: c.summary, date: new Date(c.timestamp).toISOString(), source: `compaction:${c.tier}`, score: 0.5 }); }
  }

  results.sort((a, b) => b.score - a.score);
  console.log(JSON.stringify(results.slice(0, RESULT_LIMIT), null, 2));
} finally {
  db.close();
}
