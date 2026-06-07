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

import { logDebug, logInfo, logWarn, logError } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { nullMemory } from "../components/null-memory.js";
import { loadAbmind } from "../utils/abmind-lazy.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export async function phaseMemory(ctx: BootCtx): Promise<PhaseResult> {
  // #864: Detect duplicate abmind — dual instances cause silent DB corruption
  const home = process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars");
  const abmindPaths = [
    join(home, "app", "node_modules", "abmind", "package.json"),
    join(home, "app", "bundle", "node_modules", "abmind", "package.json"),
  ];
  const existing = abmindPaths.filter(p => existsSync(p));
  if (existing.length > 1) {
    logError("boot", `FATAL: duplicate abmind at ${existing.map(p => p.replace("/package.json", "")).join(" + ")}. Delete one to prevent dual DB connections. Refusing to start.`);
    process.exit(1);
  }

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
