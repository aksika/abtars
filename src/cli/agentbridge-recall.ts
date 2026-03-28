#!/usr/bin/env node
/**
 * agentbridge-recall — CLI wrapper for the recall engine.
 *
 * Usage:
 *   agentbridge-recall --translated "kw1,kw2" --chat-id 7773842843
 *   agentbridge-recall --translated "puppy" --original "kiskutya" --chat-id 7773842843
 *   agentbridge-recall --translated "puppy" --chat-id 123 --stages S1,S3
 *
 * Legacy: --keywords is accepted as alias for --translated.
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MemoryIndex } from "../components/memory-index.js";
import { recallSearch } from "../components/recall-engine.js";

const MEMORY_DIR = join(homedir(), ".agentbridge", "memory");
const DB_PATH = join(MEMORY_DIR, "memory.db");
const CTX_START_PATH = join(MEMORY_DIR, "context-window-start.json");
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function parseArgs() {
  const args = process.argv.slice(2);
  let translated: string[] = [];
  let original: string | undefined;
  let timeStart: number | undefined;
  let timeEnd: number | undefined;
  let chatId = 0;
  let limit = DEFAULT_LIMIT;
  let maxClassification = 2;
  let stages: string[] | undefined;
  let entity: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--translated":
      case "--keywords": // legacy alias
        translated = (args[++i] ?? "").split(",").map(k => k.trim()).filter(Boolean); break;
      case "--original": original = args[++i]; break;
      case "--time-start": timeStart = parseInt(args[++i] ?? "", 10) || undefined; break;
      case "--time-end": timeEnd = parseInt(args[++i] ?? "", 10) || undefined; break;
      case "--chat-id": chatId = parseInt(args[++i] ?? "", 10) || 0; break;
      case "--limit": limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(args[++i] ?? "", 10) || DEFAULT_LIMIT)); break;
      case "--max-classification": maxClassification = Math.min(2, Math.max(0, parseInt(args[++i] ?? "", 10))); break;
      case "--stages": stages = (args[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean); break;
      case "--entity": entity = args[++i]; break;
    }
  }

  if ((!translated.length && !entity) || !chatId) {
    console.error('Usage: agentbridge-recall --translated "kw1,kw2" --chat-id <id> [--original <kw>] [--entity "Name"] [--stages S1,S3]');
    process.exit(1);
  }
  return { translated, original, timeStart, timeEnd, chatId, limit, maxClassification, stages, entity };
  return { translated, original, timeStart, timeEnd, chatId, limit, maxClassification, stages };
}

if (!existsSync(DB_PATH)) {
  console.error(`Memory database not found: ${DB_PATH}`);
  process.exit(1);
}

const params = parseArgs();
const db = new Database(DB_PATH);

// Register strip_emojis for FTS5 delete trigger compatibility
db.function("strip_emojis", (text: unknown) => {
  if (typeof text !== "string") return text;
  return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").replace(/ {2,}/g, " ").trim();
});

try {
  const index = new MemoryIndex(db);
  const result = await recallSearch(
    { db, index, memoryDir: MEMORY_DIR, ctxStartPath: CTX_START_PATH },
    {
      translated: params.translated,
      original: params.original,
      chatId: params.chatId,
      limit: params.limit,
      maxClassification: params.maxClassification,
      timeStart: params.timeStart,
      timeEnd: params.timeEnd,
      stages: params.stages,
      entity: params.entity,
    },
  );

  // Bump recall count for extracted memories that made it into results
  index.bumpRecallCount(result.extractedIds);

  // JSON output to stdout
  console.log(JSON.stringify(result.results, null, 2));

  // Hit-rate summary to stderr
  const stageSummary = Object.entries(result.stages).map(([k, v]) => `${k}=${v.hits.length}`).join(" ");
  const query = params.translated.join(" ");
  console.error(`[recall] query="${query}" ${stageSummary} short_circuit=${result.shortCircuitAfter ?? "none"} total=${result.results.length}`);

  // Expand hint
  const expandable = result.results.filter(r => r.source_ids);
  if (expandable.length) {
    const allIds = expandable.map(r => r.source_ids).join(",");
    console.error(`\nHint: ${expandable.length} result(s) have source message IDs. Expand with:\n  agentbridge-expand --ids ${allIds}`);
  }
} finally {
  db.close();
}
