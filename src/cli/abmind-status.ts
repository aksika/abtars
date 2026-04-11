#!/usr/bin/env node
/** abmind status — Show memory system stats. */

import { loadMemoryConfig } from "@agentbridge/memory/memory-config.js";
import { MemoryManager } from "@agentbridge/memory/memory-manager.js";

const config = loadMemoryConfig();
const memory = new MemoryManager(config);
await memory.initialize({ skipEmbeddingCheck: true });

const stats = memory.getStats();
if (!stats) { console.error("Memory not initialized"); process.exit(1); }

console.log(`Memory Status
─────────────
Messages:     ${stats.totalMessages}
Memories:     ${stats.extractedMemories}
DB size:      ${(stats.dbSizeBytes / 1024 / 1024).toFixed(1)} MB
Heartbeat:    ${stats.heartbeatRunning ? "running" : "stopped"}

By type:`);
for (const [type, count] of Object.entries(stats.extractedByType)) {
  console.log(`  ${type}: ${count}`);
}
console.log(`\nConsolidation files:
  Daily:     ${stats.consolidationFiles.daily}
  Weekly:    ${stats.consolidationFiles.weekly}
  Quarterly: ${stats.consolidationFiles.quarterly}`);

memory.close();
