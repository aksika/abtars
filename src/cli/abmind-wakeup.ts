#!/usr/bin/env node
/** abmind wake-up — Print current wake-up context. */

import { loadMemoryConfig } from "abmind/memory-config.js";
import { MemoryManager } from "abmind/memory-manager.js";

const ctxWindow = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--ctx-window") ?? "128000", 10);

const config = loadMemoryConfig();
const memory = new MemoryManager(config);
await memory.initialize({ skipEmbeddingCheck: true });

const wakeUp = memory.buildWakeUp(ctxWindow);
if (wakeUp) {
  console.log(wakeUp);
  console.log(`\n--- ${wakeUp.length} chars, budget=${Math.floor(ctxWindow * 0.01)} tokens ---`);
} else {
  console.log("No wake-up context available.");
}

memory.close();
