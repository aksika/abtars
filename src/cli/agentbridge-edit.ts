#!/usr/bin/env node
/**
 * agentbridge-edit — CLI for modifying existing extracted memories.
 *
 * Lookup by memory ID:
 *   agentbridge-edit --memory-id 42 --translated "corrected" --caller dreamy
 *
 * Lookup by platform message ID:
 *   agentbridge-edit --message-id 12345 --chat-id 7773842843 --emotion-score 3
 *
 * Dry run:
 *   agentbridge-edit --memory-id 42 --translated "test" --dry-run
 *
 * Output: { "ok": true, "memoriesUpdated": 1, "ids": [42], "fieldsUpdated": ["content_en"] }
 */

import { loadMemoryConfig } from "../memory/memory-config.js";
import type { EditMemoryParams } from "../types/index.js";
import { appendFileSync } from "node:fs";
import { agentBridgeHome } from "../paths.js";
import { join } from "node:path";

export type RawEditArgs = {
  memoryId?: string;
  messageId?: string;
  chatId?: string;
  contentEn?: string;
  contentOriginal?: string;
  keyword?: string;
  memoryType?: string;
  emotionScore?: string;
  confidence?: string;
  trust?: string;
  integrity?: string;
  credibility?: string;
  classification?: string;
  relevanceScore?: string;
  caller?: string;
  userOverride?: boolean;
  dryRun?: boolean;
};

export function parseEditArgs(argv: string[]): RawEditArgs {
  const args = argv.slice(2);

  if (args.includes('--help')) {
    console.log(`Usage:
  agentbridge-edit --memory-id <id> --translated "corrected" --caller <name>
  agentbridge-edit --message-id <id> --chat-id <id> --emotion-score <n>
  agentbridge-edit --memory-id <id> --translated "test" --dry-run

Options:
  --memory-id <id>        Lookup by memory ID
  --message-id <id>       Lookup by platform message ID
  --chat-id <id>          Required with --message-id
  --translated <text>     New English content (alias: --content-en)
  --original <text>       New original content (alias: --content-original)
  --keyword <kw>          Update tags (legacy alias: --tags)
  --tags <tags>           Comma-separated tags
  --memory-type <type>    Update memory type
  --emotion-score <n>     Update emotion score
  --confidence <n>        Update confidence
  --trust <n>             Update trust score
  --integrity <n>         Update integrity score
  --credibility <n>       Update credibility score
  --classification <n>    Update classification level
  --relevance-score <v>   Update relevance score
  --caller <name>         Caller identifier
  --user-override         Flag as user override
  --dry-run               Preview changes without writing`);
    process.exit(0);
  }

  const parsed: RawEditArgs = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--memory-id": parsed.memoryId = args[++i] ?? ""; break;
      case "--message-id": parsed.messageId = args[++i] ?? ""; break;
      case "--chat-id": parsed.chatId = args[++i] ?? ""; break;
      case "--translated":
      case "--content-en": parsed.contentEn = args[++i] ?? ""; break;
      case "--original":
      case "--content-original": parsed.contentOriginal = args[++i] ?? ""; break;
      case "--keyword":
      case "--tags": parsed.keyword = args[++i] ?? ""; break;
      case "--memory-type": parsed.memoryType = args[++i] ?? ""; break;
      case "--emotion-score": parsed.emotionScore = args[++i] ?? ""; break;
      case "--confidence": parsed.confidence = args[++i] ?? ""; break;
      case "--trust": parsed.trust = args[++i] ?? ""; break;
      case "--integrity": parsed.integrity = args[++i] ?? ""; break;
      case "--credibility": parsed.credibility = args[++i] ?? ""; break;
      case "--classification": parsed.classification = args[++i] ?? ""; break;
      case "--relevance-score": parsed.relevanceScore = args[++i] ?? ""; break;
      case "--caller": parsed.caller = args[++i] ?? ""; break;
      case "--user-override": parsed.userOverride = true; break;
      case "--dry-run": parsed.dryRun = true; break;
    }
  }
  return parsed;
}

export function buildEditParams(raw: RawEditArgs): { ok: true; params: EditMemoryParams } | { ok: false; error: string } {
  const params: EditMemoryParams = {};

  if (raw.memoryId) {
    const id = parseInt(raw.memoryId, 10);
    if (!Number.isFinite(id)) return { ok: false, error: "invalid --memory-id" };
    params.memoryId = id;
  }
  if (raw.messageId) {
    const id = parseInt(raw.messageId, 10);
    if (!Number.isFinite(id)) return { ok: false, error: "invalid --message-id" };
    params.messageId = id;
  }
  if (raw.chatId) {
    const id = parseInt(raw.chatId, 10);
    if (!Number.isFinite(id)) return { ok: false, error: "invalid --chat-id" };
    params.chatId = id;
  }

  if (!params.memoryId && !params.messageId) return { ok: false, error: "--memory-id or --message-id required" };
  if (params.messageId && !params.chatId) return { ok: false, error: "--chat-id required with --message-id" };

  if (raw.contentEn) params.contentEn = raw.contentEn;
  if (raw.contentOriginal) params.contentOriginal = raw.contentOriginal;
  if (raw.keyword !== undefined) params.keyword = raw.keyword;
  if (raw.memoryType) params.memoryType = raw.memoryType as EditMemoryParams["memoryType"];
  if (raw.emotionScore) params.emotionScore = parseInt(raw.emotionScore, 10);
  if (raw.confidence) params.confidence = parseInt(raw.confidence, 10);
  if (raw.trust) params.trust = parseInt(raw.trust, 10);
  if (raw.integrity) params.integrity = parseInt(raw.integrity, 10);
  if (raw.credibility) params.credibility = parseInt(raw.credibility, 10);
  if (raw.classification) params.classification = parseInt(raw.classification, 10);
  if (raw.relevanceScore) params.relevanceScore = raw.relevanceScore;
  if (raw.caller) params.caller = raw.caller;
  if (raw.userOverride) params.userOverride = true;
  if (raw.dryRun) params.dryRun = true;

  return { ok: true, params };
}

async function main() {
  const raw = parseEditArgs(process.argv);
  const validation = buildEditParams(raw);
  if (!validation.ok) {
    console.log(JSON.stringify({ ok: false, error: validation.error }));
    process.exit(1);
  }

  const { params } = validation;

  // Prompt injection scan on content edits
  if (params.contentEn || params.contentOriginal) {
    const { scanPrompt } = await import("../components/prompt-scanner.js");
    const hit = scanPrompt(params.contentEn ?? "")
      ?? (params.contentOriginal ? scanPrompt(params.contentOriginal) : null);
    if (hit) {
      const logLine = `${new Date().toLocaleString("sv-SE")} EDIT-BLOCKED patternId=${hit.patternId} matched="${hit.matched}" caller=${params.caller ?? "unknown"}\n`;
      const logPath = join(agentBridgeHome(), "logs", "prompt_injection.log");
      try { appendFileSync(logPath, logLine); } catch { /* best-effort */ }
      console.log(JSON.stringify({ ok: false, error: `Prompt injection detected (${hit.patternId}): "${hit.matched}"`, blocked: true }));
      process.exit(1);
    }
  }

  const config = loadMemoryConfig();
  const { createMemoryBackend } = await import("../memory/backend-factory.js");
  const backend = await createMemoryBackend(config);
  try {
    const result = await backend.editMemory(params);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exit(1);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  } finally {
    backend.close();
  }
}

const isDirectRun = process.argv[1]?.endsWith("agentbridge-edit.ts") ||
  process.argv[1]?.endsWith("agentbridge-edit.js");
if (isDirectRun) {
  main();
}
