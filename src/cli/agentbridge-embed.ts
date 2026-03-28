#!/usr/bin/env node
/**
 * agentbridge-embed — one-time batch embedding of all extracted_memories.
 * Usage: agentbridge-embed
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { loadEmbedConfig, batchEmbed } from "../components/ollama-embed.js";

const DB_PATH = join(homedir(), ".agentbridge", "memory", "memory.db");

if (!existsSync(DB_PATH)) {
  console.error(`Memory database not found: ${DB_PATH}`);
  process.exit(1);
}

const config = loadEmbedConfig();
if (!config.enabled) {
  console.error("EMBEDDING_ENABLED is not true. Set EMBEDDING_ENABLED=true in .env");
  process.exit(1);
}

const db = new Database(DB_PATH);
try {
  // Ensure embedding column exists
  try { db.exec("ALTER TABLE extracted_memories ADD COLUMN embedding BLOB"); } catch (_) {}

  const count = await batchEmbed(config, db);
  console.log(`Embedded ${count} memories`);
} finally {
  db.close();
}
