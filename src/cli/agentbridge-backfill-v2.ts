#!/usr/bin/env node
/**
 * agentbridge-backfill-v2 — One-time migration: fill ABM v2 columns on existing memories.
 * Runs emotion tagger + importance flagger + compressor + signature generator on all
 * memories that have NULL content_compressed. No LLM needed — pure regex/string ops.
 *
 * Usage: node dist/cli/agentbridge-backfill-v2.js [--dry-run]
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { agentBridgeHome } from "../memory/mem-paths.js";
import { detectEmotions } from "../memory/emotion-tagger.js";
import { detectFlags } from "../memory/importance-flagger.js";
import { compress } from "../memory/memory-compressor.js";
import { generateSignature } from "../memory/signature-generator.js";

const dryRun = process.argv.includes("--dry-run");
const dbPath = join(agentBridgeHome(), "memory", "memory.db");

const db = new Database(dbPath);
const rows = db.prepare(
  "SELECT id, content_en, topic, confidence, created_at FROM extracted_memories WHERE content_compressed IS NULL AND content_en IS NOT NULL",
).all() as Array<{ id: number; content_en: string; topic: string | null; confidence: number | null; created_at: number }>;

console.log(`Found ${rows.length} memories to backfill${dryRun ? " (dry run)" : ""}`);

const update = db.prepare(
  "UPDATE extracted_memories SET emotion_tags = ?, importance_flags = ?, content_compressed = ?, signature = ? WHERE id = ?",
);

let count = 0;
const txn = db.transaction(() => {
  for (const row of rows) {
    const emotionTags = detectEmotions(row.content_en).join(",");
    const importanceFlags = detectFlags(row.content_en).join(",");
    const compressed = compress({
      content_en: row.content_en,
      topic: row.topic ?? "general",
      emotion_tags: emotionTags,
      importance_flags: importanceFlags,
      confidence: row.confidence ?? 3,
      date: new Date(row.created_at).toISOString().slice(0, 7),
    });
    const signature = Buffer.from(generateSignature(row.content_en));

    if (!dryRun) {
      update.run(emotionTags || null, importanceFlags || null, compressed, signature, row.id);
    }
    count++;
    if (count % 100 === 0) console.log(`  ${count}/${rows.length}...`);
  }
});

txn();
console.log(`Done: ${count} memories backfilled${dryRun ? " (dry run — no changes written)" : ""}`);
db.close();
