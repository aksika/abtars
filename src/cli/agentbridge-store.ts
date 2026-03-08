#!/usr/bin/env node
/**
 * agentbridge-store — standalone CLI for agent-initiated memory storage.
 *
 * Persists a memory immediately via MemoryManager.instantStore().
 * The agent decides when to invoke this based on conversation context.
 *
 * Usage:
 *   agentbridge-store \
 *     --content-en "User prefers dark mode" \
 *     --content-original "A user dark mode-ot preferálja" \
 *     --memory-type preference \
 *     --emotion-score 0 \
 *     --chat-id 7773842843 \
 *     --keyword "dark mode"
 *
 * Output (success):
 *   { "stored": true, "memoriesCount": 1 }
 *
 * Output (error):
 *   { "stored": false, "error": "content-en is required" }
 */

import { MemoryManager } from "../components/memory-manager.js";
import { loadMemoryConfig } from "../components/memory-config.js";
import type { InstantStoreParams } from "../types/index.js";

export type RawArgs = {
  contentEn?: string;
  contentOriginal?: string;
  memoryType?: string;
  emotionScore?: string;
  chatId?: string;
  keyword?: string;
};

export function parseArgs(argv: string[]): RawArgs {
  const args = argv.slice(2);
  const parsed: RawArgs = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--content-en": parsed.contentEn = args[++i] ?? ""; break;
      case "--content-original": parsed.contentOriginal = args[++i] ?? ""; break;
      case "--memory-type": parsed.memoryType = args[++i] ?? ""; break;
      case "--emotion-score": parsed.emotionScore = args[++i] ?? ""; break;
      case "--chat-id": parsed.chatId = args[++i] ?? ""; break;
      case "--keyword": parsed.keyword = args[++i] ?? ""; break;
    }
  }

  return parsed;
}

/**
 * Validate raw CLI arguments and return either parsed InstantStoreParams or an error string.
 */
export function validateArgs(raw: RawArgs): { ok: true; params: InstantStoreParams } | { ok: false; error: string } {
  if (!raw.contentEn) return { ok: false, error: "content-en is required" };
  if (!raw.contentOriginal) return { ok: false, error: "content-original is required" };
  if (!raw.memoryType) return { ok: false, error: "memory-type is required" };
  if (raw.emotionScore === undefined) return { ok: false, error: "emotion-score is required" };
  if (!raw.chatId) return { ok: false, error: "chat-id is required" };

  const chatId = parseInt(raw.chatId, 10);
  if (!Number.isFinite(chatId) || chatId === 0) return { ok: false, error: "invalid chat-id" };

  const validTypes = new Set(["fact", "decision", "preference", "event"]);
  if (!validTypes.has(raw.memoryType)) return { ok: false, error: "invalid memory_type" };

  return {
    ok: true,
    params: {
      chatId,
      contentEn: raw.contentEn,
      contentOriginal: raw.contentOriginal,
      memoryType: raw.memoryType as InstantStoreParams["memoryType"],
      emotionScore: parseInt(raw.emotionScore, 10) || 0,
      keyword: raw.keyword,
    },
  };
}

// --- CLI entry point (only runs when executed directly) ---

async function main() {
  const raw = parseArgs(process.argv);
  const validation = validateArgs(raw);

  if (!validation.ok) {
    console.log(JSON.stringify({ stored: false, error: validation.error }));
    process.exit(1);
  }

  const config = loadMemoryConfig();
  const memory = new MemoryManager(config);

  try {
    await memory.initialize();
    const result = await memory.instantStore(validation.params);
    console.log(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ stored: false, error: message }));
  } finally {
    memory.close();
  }
}

// Only run when executed as a script, not when imported for testing
const isDirectRun = process.argv[1]?.endsWith("agentbridge-store.ts") ||
  process.argv[1]?.endsWith("agentbridge-store.js");
if (isDirectRun) {
  main();
}
