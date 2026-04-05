#!/usr/bin/env node
/**
 * rebuild-db — Repopulate memory.db from transcript JSONL files.
 * Restores: messages, chat_backup, messages_fts (via triggers)
 * Usage: node dist/cli/rebuild-db.js [--dry-run]
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../paths.js";
import Database from "better-sqlite3";

const memoryDir = join(agentBridgeHome(), "memory");
const dbPath = join(memoryDir, "memory.db");
const transcriptsDir = join(memoryDir, "transcripts");
const dryRun = process.argv.includes("--dry-run");

interface Line { role: string; content: string; timestamp: number; chatId: number; sessionId: string }

function stripEmojis(text: string): string {
  return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").replace(/ {2,}/g, " ").trim();
}

function loadTranscripts(): Line[] {
  const lines: Line[] = [];
  if (!existsSync(transcriptsDir)) { console.error("No transcripts dir"); process.exit(1); }
  for (const chatDir of readdirSync(transcriptsDir, { withFileTypes: true })) {
    if (!chatDir.isDirectory()) continue;
    for (const file of readdirSync(join(transcriptsDir, chatDir.name))) {
      if (!file.endsWith(".jsonl")) continue;
      for (const raw of readFileSync(join(transcriptsDir, chatDir.name, file), "utf-8").split("\n")) {
        if (!raw.trim()) continue;
        try { lines.push(JSON.parse(raw)); } catch { /* skip */ }
      }
    }
  }
  return lines.sort((a, b) => a.timestamp - b.timestamp);
}

const lines = loadTranscripts();
console.log(`Found ${lines.length} transcript lines`);

if (dryRun) {
  const chats = new Map<number, number>();
  for (const l of lines) chats.set(l.chatId, (chats.get(l.chatId) ?? 0) + 1);
  for (const [id, n] of chats) console.log(`  Chat ${id}: ${n} messages`);
  process.exit(0);
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const existing = (db.prepare("SELECT COUNT(*) as cnt FROM messages").get() as { cnt: number }).cnt;
if (existing > 0) { console.error(`DB has ${existing} messages — aborting. Delete DB first for full rebuild.`); process.exit(1); }

const insertMsg = db.prepare("INSERT INTO messages (chat_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
const insertBackup = db.prepare("INSERT INTO chat_backup (chat_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");

db.transaction(() => {
  for (const l of lines) {
    const clean = stripEmojis(l.content);
    if (!clean) continue;
    insertMsg.run(l.chatId, l.sessionId, l.role, clean, l.timestamp);
    insertBackup.run(l.chatId, l.sessionId, l.role, clean, l.timestamp);
  }
})();

const msgCount = (db.prepare("SELECT COUNT(*) as cnt FROM messages").get() as { cnt: number }).cnt;
const ftsCount = (db.prepare("SELECT COUNT(*) as cnt FROM messages_fts").get() as { cnt: number }).cnt;
console.log(`✅ ${msgCount} messages restored (FTS: ${ftsCount})`);
console.log(`✅ chat_backup populated`);
console.log(`⚠️  extracted_memories empty — heartbeat will re-extract`);
db.close();
