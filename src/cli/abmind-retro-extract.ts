#!/usr/bin/env node
/**
 * abmind-retro-extract — Extract durable facts from retrospective files.
 *
 * Parses retro markdown, extracts bullets from "What did I learn?" (facts)
 * and "How can I improve?" (decisions), stores via instantStore().
 *
 * Usage:
 *   abmind-retro-extract [--dry-run] [--verbose]
 */

import { readdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createMemoryBackend } from "abmind/backend-factory.js";
import { loadMemoryConfig } from "abmind/memory-config.js";
import { agentBridgeHome } from "../paths.js";
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

async function main(): Promise<void> {
  const flags = parseArgs(process.argv);
  const retroDir = join(agentBridgeHome(), "memory", "retrospectives");

  if (!existsSync(retroDir)) {
    if (flags.verbose) console.log(`[${TAG}] No retrospectives directory`);
    return;
  }

  const files = readdirSync(retroDir).filter(f => f.startsWith("retro_") && f.endsWith(".md")).sort();

  if (files.length === 0) {
    if (flags.verbose) console.log(`[${TAG}] No unprocessed retro files`);
    return;
  }

  const backend = await createMemoryBackend(loadMemoryConfig());
  try {

    let totalStored = 0;

    for (const file of files) {
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

        const result = await backend.instantStore(params);
        if (result.stored) totalStored++;
        if (flags.verbose) console.log(`[${TAG}]   ${result.stored ? "✓" : "✗"} ${item.memoryType}: ${item.content.slice(0, 80)}`);
      }

      if (!flags.dryRun) {
        renameSync(join(retroDir, file), join(retroDir, file.replace(".md", ".done")));
      }
    }

    if (!flags.dryRun) {
      console.log(`[${TAG}] Stored ${totalStored} items from ${files.length} retro file(s)`);
    }
  } finally {
    await backend.close();
  }
}

const isDirectRun =
  process.argv[1]?.endsWith("abmind-retro-extract.js") ||
  process.argv[1]?.endsWith("abmind-retro-extract.ts");

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
