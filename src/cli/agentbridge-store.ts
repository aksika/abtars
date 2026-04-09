#!/usr/bin/env node
/**
 * agentbridge-store — standalone CLI for agent-initiated memory storage.
 *
 * Persists a memory immediately via MemoryManager.instantStore().
 * The agent decides when to invoke this based on conversation context.
 *
 * Usage:
 *   agentbridge-store \
 *     --translated "User prefers dark mode" \
 *     --original "A user dark mode-ot preferálja" \
 *     --memory-type preference \
 *     --emotion-score 0 \
 *     --chat-id 7773842843 \
 *     --keyword "dark mode"
 *
 * Legacy aliases: --content-en (→ --translated), --content-original (→ --original)
 *
 * Output (success):
 *   { "stored": true, "memoriesCount": 1 }
 *
 * Output (error):
 *   { "stored": false, "error": "content-en is required" }
 */

import { loadMemoryConfig } from "../memory/memory-config.js";
import type { InstantStoreParams } from "../types/index.js";
import { appendFileSync } from "node:fs";
import { agentBridgeHome } from "../paths.js";
import { join } from "node:path";

export type RawArgs = {
  contentEn?: string;
  contentOriginal?: string;
  memoryType?: string;
  emotionScore?: string;
  emotionTags?: string;
  emotionContext?: string;
  chatId?: string;
  keyword?: string;
  confidence?: string;
  sourceMessageIds?: string;
  topic?: string;
  boost?: boolean;
  demote?: boolean;
  id?: string;
  merge?: boolean;
  mergeIds?: string;
  classification?: string;
  trust?: string;
  integrity?: string;
  credibility?: string;
  reclassify?: boolean;
  userOverride?: boolean;
  deleteIds?: string;
};

export function parseArgs(argv: string[]): RawArgs {
  const args = argv.slice(2);

  if (args.includes('--help')) {
    console.log(`Usage:
  agentbridge-store --translated <text> --original <text> --memory-type <type> --emotion-score <n> --chat-id <id>

Options:
  --translated <text>     English content (alias: --content-en)
  --original <text>       Original content (alias: --content-original)
  --memory-type <type>    fact | decision | preference | event
  --emotion-score <n>     Emotion score
  --chat-id <id>          Chat ID (required)
  --keyword <kw>          Keyword tag (legacy alias: --tags)
  --tags <tags>           Comma-separated tags
  --confidence <n>        Confidence score
  --source-ids <ids>      Source message IDs
  --classification <n>    Classification level
  --trust <n>             Trust score
  --integrity <n>         Integrity score
  --credibility <n>       Credibility score
  --boost                 Boost relevance (+10) for --id
  --demote                Demote relevance (-10) for --id
  --id <id>               Memory ID (for boost/demote/reclassify)
  --merge                 Merge two memories
  --merge-ids <a,b>       Two IDs to merge
  --reclassify            Reclassify memory (requires --id, --classification)
  --user-override         Flag as user override
  --delete-ids <ids>      Cascade delete by message IDs (requires --chat-id)`);
    process.exit(0);
  }

  const parsed: RawArgs = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--translated":
      case "--content-en": parsed.contentEn = args[++i] ?? ""; break;
      case "--original":
      case "--content-original": parsed.contentOriginal = args[++i] ?? ""; break;
      case "--memory-type": parsed.memoryType = args[++i] ?? ""; break;
      case "--emotion-score": parsed.emotionScore = args[++i] ?? ""; break;
      case "--emotion-tags": parsed.emotionTags = args[++i] ?? ""; break;
      case "--emotion-context": parsed.emotionContext = args[++i] ?? ""; break;
      case "--chat-id": parsed.chatId = args[++i] ?? ""; break;
      case "--keyword":
      case "--tags": parsed.keyword = args[++i] ?? ""; break;
      case "--confidence": parsed.confidence = args[++i] ?? ""; break;
      case "--topic": parsed.topic = args[++i] ?? ""; break;
      case "--source-ids": parsed.sourceMessageIds = args[++i] ?? ""; break;
      case "--boost": parsed.boost = true; break;
      case "--demote": parsed.demote = true; break;
      case "--id": parsed.id = args[++i] ?? ""; break;
      case "--merge": parsed.merge = true; break;
      case "--merge-ids": parsed.mergeIds = args[++i] ?? ""; break;
      case "--classification": parsed.classification = args[++i] ?? ""; break;
      case "--trust": parsed.trust = args[++i] ?? ""; break;
      case "--integrity": parsed.integrity = args[++i] ?? ""; break;
      case "--credibility": parsed.credibility = args[++i] ?? ""; break;
      case "--reclassify": parsed.reclassify = true; break;
      case "--user-override": parsed.userOverride = true; break;
      case "--delete-ids": parsed.deleteIds = args[++i] ?? ""; break;
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
      emotionTags: raw.emotionTags || undefined,
      emotionContext: raw.emotionContext || undefined,
      keyword: raw.keyword,
      classification: raw.classification ? parseInt(raw.classification, 10) : undefined,
      trust: raw.trust ? parseInt(raw.trust, 10) : undefined,
      integrity: raw.integrity ? parseInt(raw.integrity, 10) : undefined,
      credibility: raw.credibility ? parseInt(raw.credibility, 10) : undefined,
      topic: raw.topic || undefined,
    },
  };
}

// --- CLI entry point (only runs when executed directly) ---

async function main() {
  const raw = parseArgs(process.argv);

  const config = loadMemoryConfig();
  const { createMemoryBackend } = await import("../memory/backend-factory.js");
  const backend = await createMemoryBackend(config);

  try {
    // --delete-ids path: cascade delete messages from DB + JSONL
    if (raw.deleteIds) {
      if (!raw.chatId) {
        console.log(JSON.stringify({ deleted: false, error: "--chat-id is required with --delete-ids" }));
        process.exit(1);
      }
      const ids = raw.deleteIds.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
      if (ids.length === 0) {
        console.log(JSON.stringify({ deleted: false, error: "no valid IDs in --delete-ids" }));
        process.exit(1);
      }
      const chatId = parseInt(raw.chatId, 10);
      const result = await backend.cascadeDelete(ids, chatId);
      console.log(JSON.stringify({ deleted: true, ...result }));
      return;
    }

    // --reclassify path: change classification level on existing memory
    if (raw.reclassify) {
      if (!raw.id || !raw.classification) {
        console.log(JSON.stringify({ stored: false, error: "--id and --classification are required with --reclassify" }));
        process.exit(1);
      }
      const id = parseInt(raw.id, 10);
      const level = parseInt(raw.classification, 10);
      const result = await backend.reclassifyMemory(id, level, raw.userOverride ?? false);
      console.log(JSON.stringify(result));
      return;
    }

    // --boost/--demote path: adjust relevance_score on existing memory
    if (raw.boost || raw.demote) {
      if (!raw.id) {
        console.log(JSON.stringify({ stored: false, error: "--id is required with --boost/--demote" }));
        process.exit(1);
      }
      const id = parseInt(raw.id, 10);
      const delta = raw.boost ? 10 : -10;
      await backend.adjustRelevance(id, delta);
      console.log(JSON.stringify({ stored: true, adjusted: { id, delta } }));
      return;
    }

    // --merge path: merge two memories into one
    if (raw.merge) {
      if (!raw.mergeIds) {
        console.log(JSON.stringify({ stored: false, error: "--merge-ids is required with --merge" }));
        process.exit(1);
      }
      const ids = raw.mergeIds.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
      if (ids.length !== 2) {
        console.log(JSON.stringify({ stored: false, error: "--merge-ids must be exactly 2 comma-separated IDs" }));
        process.exit(1);
      }
      const result = await backend.mergeMemories(ids[0]!, ids[1]!);
      console.log(JSON.stringify(result));
      return;
    }

    // Normal store path
    const validation = validateArgs(raw);
    if (!validation.ok) {
      console.log(JSON.stringify({ stored: false, error: validation.error }));
      process.exit(1);
    }

    // Prompt injection scan for trust < 5
    const trust = validation.params.trust ?? 0;
    if (trust < 5) {
      const { scanPrompt } = await import("../components/prompt-scanner.js");
      const hit = scanPrompt(validation.params.contentEn)
        ?? (validation.params.contentOriginal ? scanPrompt(validation.params.contentOriginal) : null);
      if (hit) {
        const logLine = `${new Date().toLocaleString("sv-SE")} BLOCKED patternId=${hit.patternId} matched="${hit.matched}" trust=${trust} content="${validation.params.contentEn.slice(0, 120)}"\n`;
        const logPath = join(agentBridgeHome(), "logs", "prompt_injection.log");
        try { appendFileSync(logPath, logLine); } catch { /* best-effort */ }
        console.log(JSON.stringify({ stored: false, error: `Prompt injection detected (${hit.patternId}): "${hit.matched}"`, blocked: true }));
        process.exit(1);
      }
    }

    const result = await backend.instantStore(validation.params);
    console.log(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ stored: false, error: message }));
  } finally {
    backend.close();
  }
}

// Only run when executed as a script, not when imported for testing
const isDirectRun = process.argv[1]?.endsWith("agentbridge-store.ts") ||
  process.argv[1]?.endsWith("agentbridge-store.js");
if (isDirectRun) {
  main();
}
