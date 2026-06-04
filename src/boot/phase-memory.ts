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
 * internal logger, not an abtars singleton).
 */

import { logDebug, logInfo, logWarn } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { nullMemory } from "../components/null-memory.js";
import { loadAbmind } from "../utils/abmind-lazy.js";

export async function phaseMemory(ctx: BootCtx): Promise<PhaseResult> {
  const mod = await loadAbmind();

  if (!mod) {
    logWarn("main", "⚠️ abmind not available — running without persistent memory");
    ctx.memory = nullMemory;
    return "skipped";
  }

  if (!ctx.memoryConfig.memoryEnabled) {
    logInfo("main", "🧠 Memory disabled");
    ctx.memory = nullMemory;
    return "skipped";
  }

  try {
    const memory = new mod.MemoryManager(ctx.memoryConfig);
    await memory.initialize();
    ctx.memory = memory;
    logDebug("main", `🧠 Memory enabled (dir=${ctx.memoryConfig.memoryDir})`);
    return "ran";
  } catch (err) {
    logWarn("main", `⚠️ Memory init failed: ${err instanceof Error ? err.message : String(err)}. Running without persistent memory.`);
    ctx.memory = nullMemory;
    return "skipped";
  }
}
