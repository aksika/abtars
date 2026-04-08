#!/usr/bin/env node
/**
 * agentbridge-expand — look up original messages by ID.
 *
 * Given comma-separated message IDs (from source_message_ids on extracted memories),
 * returns the original messages from the messages table.
 *
 * Usage:
 *   agentbridge-expand --ids 451,452,453
 */

import { localISO } from "../utils/local-time.js";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../paths.js";

const MEMORY_DIR = join(agentBridgeHome(), "memory");
const DB_PATH = join(MEMORY_DIR, "memory.db");

export function parseArgs(argv = process.argv): { ids: number[] } {
  const args = argv.slice(2);

  if (args.includes('--help')) {
    console.log(`Usage:
  agentbridge-expand --ids <id1,id2,...>

Options:
  --ids <ids>    Comma-separated message IDs to expand`);
    process.exit(0);
  }

  let ids: number[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ids") {
      ids = (args[++i] ?? "").split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
    }
  }

  if (!ids.length) {
    console.error("Usage: agentbridge-expand --ids <id1,id2,...>");
    process.exit(1);
  }
  return { ids };
}

// Only run as CLI entry point (not when imported for tests)
const isMain = process.argv[1]?.endsWith("agentbridge-expand.js") || process.argv[1]?.endsWith("agentbridge-expand.ts");
if (isMain) {
  if (!existsSync(DB_PATH)) {
    console.error(`Memory database not found: ${DB_PATH}`);
    process.exit(1);
  }

  const { ids } = parseArgs();
  const db = new Database(DB_PATH, { readonly: true });

  try {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, role, content, timestamp, chat_id FROM messages WHERE id IN (${placeholders}) ORDER BY timestamp ASC`
    ).all(...ids) as Array<{ id: number; role: string; content: string; timestamp: number; chat_id: number }>;

    const results = rows.map(r => ({
      id: r.id,
      role: r.role,
      content: r.content,
      date: localISO(new Date(r.timestamp)),
      chat_id: r.chat_id,
    }));

    console.log(JSON.stringify(results, null, 2));
  } finally {
    db.close();
  }
}
