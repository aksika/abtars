#!/usr/bin/env node
/**
 * agentbridge-recall — standalone CLI for agent-initiated memory search.
 *
 * Uses the existing MemoryIndex (FTS5 + substring) search pipeline.
 * Falls back through: FTS5 → substring LIKE → original-language → consolidation file search.
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
import { searchConsolidationFiles } from "../components/consolidation-search.js";
import type { SearchResult, MemorySearchResult } from "../types/memory.js";

const MEMORY_DIR = join(homedir(), ".agentbridge", "memory");
const DB_PATH = join(MEMORY_DIR, "memory.db");
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function parseArgs() {
  const args = process.argv.slice(2);
  let keywords: string[] = [];
  let original: string | undefined;
  let timeStart: number | undefined;
  let timeEnd: number | undefined;
  let chatId = 0;
  let limit = DEFAULT_LIMIT;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--keywords": keywords = (args[++i] ?? "").split(",").map(k => k.trim()).filter(Boolean); break;
      case "--original": original = args[++i]; break;
      case "--time-start": timeStart = parseInt(args[++i] ?? "", 10) || undefined; break;
      case "--time-end": timeEnd = parseInt(args[++i] ?? "", 10) || undefined; break;
      case "--chat-id": chatId = parseInt(args[++i] ?? "", 10) || 0; break;
      case "--limit": limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(args[++i] ?? "", 10) || DEFAULT_LIMIT)); break;
    }
  }

  if (!keywords.length || !chatId) {
    console.error("Usage: agentbridge-recall --keywords \"kw1,kw2\" --chat-id <id> [--original <kw>] [--limit <N>] [--time-start <ms>] [--time-end <ms>]");
    process.exit(1);
  }
  return { keywords, original, timeStart, timeEnd, chatId, limit };
}

if (!existsSync(DB_PATH)) {
  console.error(`Memory database not found: ${DB_PATH}`);
  process.exit(1);
}

const params = parseArgs();
const db = new Database(DB_PATH, { readonly: true });

try {
  const index = new MemoryIndex(db);
  const searchOpts = { chatId: params.chatId, startTime: params.timeStart, endTime: params.timeEnd, limit: params.limit * 3 };
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

  // Stage 2: Relaxed FTS5 (OR-style, drops short tokens) — always run when limit > 10
  if (results.length === 0 || params.limit > 10) {
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
  const extractedIds: number[] = [];
  const addExtracted = (r: MemorySearchResult, source: string) => {
    const key = `${r.source_timestamp}:${r.content.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (r.id !== undefined) extractedIds.push(r.id);
    results.push({ content: r.content, date: new Date(r.source_timestamp).toISOString(), source, score: r.score });
  };

  for (const r of index.searchExtracted(query, searchOpts)) addExtracted(r, "extracted");

  // Stage 6: Extracted memories — original language (L4)
  if (params.original) {
    for (const r of index.searchOriginal(params.original, { chatId: params.chatId, limit: params.limit * 3 })) addExtracted(r, "extracted:original");
  }

  // Stage 7: Compaction summaries — file-based search
  const allKw = [...params.keywords];
  if (params.original) allKw.push(params.original);
  const consolidationResults = searchConsolidationFiles(MEMORY_DIR, allKw, {
    startTime: params.timeStart,
    endTime: params.timeEnd,
  });
  for (const c of consolidationResults) {
    const key = `${c.timestamp}:${c.content.slice(0, 80)}`;
    if (!seen.has(key)) { seen.add(key); results.push({ content: c.content, date: new Date(c.timestamp).toISOString(), source: `compaction:${c.tier}`, score: 0.5 }); }
  }

  // Stage 8: chat_backup fallback (LIKE search on immutable backup)
  if (results.length < params.limit) {
    const bkConditions = ["chat_id = ?"];
    const bkParams: (string | number)[] = [params.chatId];
    if (params.timeStart) { bkConditions.push("timestamp >= ?"); bkParams.push(params.timeStart); }
    if (params.timeEnd) { bkConditions.push("timestamp <= ?"); bkParams.push(params.timeEnd); }
    bkConditions.push(`(${allKw.map(kw => { bkParams.push(`%${kw}%`); return "content LIKE ?"; }).join(" OR ")})`);
    const backupRows = db.prepare(`SELECT role, content, timestamp FROM chat_backup WHERE ${bkConditions.join(" AND ")} ORDER BY timestamp DESC LIMIT 20`).all(...bkParams) as Array<{ role: string; content: string; timestamp: number }>;
    for (const r of backupRows) {
      const key = `${r.timestamp}:${r.content.slice(0, 80)}`;
      if (!seen.has(key)) { seen.add(key); results.push({ content: `[${r.role}] ${r.content}`, date: new Date(r.timestamp).toISOString(), source: "backup", score: 0.3 }); }
    }
  }

  results.sort((a, b) => b.score - a.score);

  // Darwinism: bump recall count for extracted memories that made it into results
  index.bumpRecallCount(extractedIds);

  console.log(JSON.stringify(results.slice(0, params.limit), null, 2));
} finally {
  db.close();
}
