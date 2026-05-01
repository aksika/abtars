/**
 * phase-memory — boot phase 2: initialize memory layer.
 *
 * - no-ops if memoryConfig.memoryEnabled is false
 * - wires setMemoryLogger
 * - constructs + initializes MemoryManager (which sources .env.memory via
 *   loadMemoryConfig → loadMemoryEnv since abmind #210)
 *
 * Populates ctx: memory.
 *
 * Owns no module-level singletons (setMemoryLogger is a setter on abmind's
 * internal logger, not an agentbridge singleton).
 */

import { MemoryManager, setLogger as setMemoryLogger } from "abmind";
import { logInfo, logWarn, logError } from "../components/logger.js";
import type { BootCtx } from "./context.js";

export async function phaseMemory(ctx: BootCtx): Promise<void> {
  if (!ctx.memoryConfig.memoryEnabled) {
    logInfo("main", "🧠 Memory disabled");
    return;
  }
  setMemoryLogger({ logInfo, logWarn, logError });

  const memory = new MemoryManager(ctx.memoryConfig);
  await memory.initialize();

  ctx.memory = memory;
  logInfo("main", `🧠 Memory enabled (dir=${ctx.memoryConfig.memoryDir})`);
}
