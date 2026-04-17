/**
 * phase-memory — boot phase 2: initialize memory layer.
 *
 * - no-ops if memoryConfig.memoryEnabled is false
 * - wires setMemoryLogger
 * - loads ABM env config + logs settings
 * - constructs + initializes MemoryManager
 *
 * Populates ctx: memory.
 *
 * Owns no module-level singletons (setMemoryLogger is a setter on abmind's
 * internal logger, not an agentbridge singleton).
 */

import { MemoryManager, setLogger as setMemoryLogger } from "abmind/index.js";
import { logInfo, logWarn, logError } from "../components/logger.js";
import type { BootCtx } from "./context.js";

export async function phaseMemory(ctx: BootCtx): Promise<void> {
  if (!ctx.memoryConfig.memoryEnabled) {
    logInfo("main", "🧠 Memory disabled");
    return;
  }
  setMemoryLogger({ logInfo, logWarn, logError });

  // Load ABM .env.memory config
  const { loadMemoryEnv } = await import("abmind/mem-config-env.js");
  const memEnv = loadMemoryEnv();
  logInfo("main", `🧠 ABM config: search=${memEnv.searchMode}, maxDB=${memEnv.maxDbSizeMb}MB, aging=${memEnv.agingEnabled}`);

  const memory = new MemoryManager(ctx.memoryConfig);
  await memory.initialize();
  ctx.memory = memory;
  logInfo("main", `🧠 Memory enabled (dir=${ctx.memoryConfig.memoryDir})`);
}
