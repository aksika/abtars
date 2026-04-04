#!/usr/bin/env node
/**
 * agentbridge-retro-extract — Extract durable facts from retrospective files.
 *
 * Parses retro markdown, extracts bullets from "What did I learn?" (facts)
 * and "How can I improve?" (decisions), stores via instantStore().
 *
 * Usage:
 *   agentbridge-retro-extract [--dry-run] [--verbose]
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MemoryManager } from "../components/memory-manager.js";
import { loadMemoryConfig } from "../components/memory-config.js";
import type { InstantStoreParams } from "../types/index.js";

const TAG = "retro-extract";

interface ExtractedItem {
  content: string;
  memoryType: "fact" | "decision";
}

function parseArgs(argv: string[]): { dryRun: boolean; verbose: boolean } {
  const args = argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    verbose: args.includes("--verbose"),
  };
}

/** Extract bullets from a section by header substring. */
function extractSection(text: string, headerMatch: string): string[] {
  const lines = text.split("\n");
  let inSection = false;
  const bullets: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ") && line.toLowerCase().includes(headerMatch.toLowerCase())) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("## ")) break;
    if (inSection && line.startsWith("- ")) {
      const content = line.slice(2).trim();
      if (content.length > 10) bullets.push(content);
    }
  }
  return bullets;
}

/** Parse a retro file and extract facts + decisions. */
export function parseRetro(content: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];

  for (const bullet of extractSection(content, "what did i learn")) {
    items.push({ content: bullet, memoryType: "fact" });
  }
  for (const bullet of extractSection(content, "how can i improve")) {
    items.push({ content: bullet, memoryType: "decision" });
  }

  return items;
}

function loadProcessed(retroDir: string): Set<string> {
  const p = join(retroDir, ".processed.json");
  if (!existsSync(p)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(p, "utf-8")));
  } catch { return new Set(); }
}

function saveProcessed(retroDir: string, processed: Set<string>): void {
  writeFileSync(join(retroDir, ".processed.json"), JSON.stringify([...processed]), "utf-8");
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv);
  const config = loadMemoryConfig();
  const retroDir = join(config.memoryDir, "retrospectives");

  if (!existsSync(retroDir)) {
    if (flags.verbose) console.log(`[${TAG}] No retrospectives directory`);
    return;
  }

  const files = readdirSync(retroDir).filter(f => f.startsWith("retro_") && f.endsWith(".md")).sort();
  const processed = loadProcessed(retroDir);
  const unprocessed = files.filter(f => !processed.has(f));

  if (unprocessed.length === 0) {
    if (flags.verbose) console.log(`[${TAG}] No unprocessed retro files`);
    return;
  }

  const memory = new MemoryManager(config);
  try {
    await memory.initialize({ skipEmbeddingCheck: true });

    let totalStored = 0;

    for (const file of unprocessed) {
      const content = readFileSync(join(retroDir, file), "utf-8");
      const items = parseRetro(content);

      if (flags.verbose) console.log(`[${TAG}] ${file}: ${items.length} items`);

      for (const item of items) {
        if (flags.dryRun) {
          console.log(`[DRY-RUN] ${item.memoryType}: ${item.content.slice(0, 100)}`);
          continue;
        }

        const params: InstantStoreParams = {
          chatId: 0,
          contentEn: item.content,
          contentOriginal: item.content,
          memoryType: item.memoryType,
          emotionScore: 0,
          confidence: 3,
          classification: 0,
        };

        const result = await memory.editor.instantStore(params);
        if (result.stored) totalStored++;
        if (flags.verbose) console.log(`[${TAG}]   ${result.stored ? "✓" : "✗"} ${item.memoryType}: ${item.content.slice(0, 80)}`);
      }

      if (!flags.dryRun) processed.add(file);
    }

    if (!flags.dryRun) {
      saveProcessed(retroDir, processed);
      console.log(`[${TAG}] Stored ${totalStored} items from ${unprocessed.length} retro file(s)`);
    }
  } finally {
    memory.close();
  }
}

const isDirectRun =
  process.argv[1]?.endsWith("agentbridge-retro-extract.js") ||
  process.argv[1]?.endsWith("agentbridge-retro-extract.ts");

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
