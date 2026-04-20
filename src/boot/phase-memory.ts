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

import { MemoryManager, setLogger as setMemoryLogger } from "abmind/index.js";
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

  // WAL checkpoint — flush pending writes from a previous crash before this process starts writing.
  try {
    const t0 = Date.now();
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(ctx.memoryConfig.memoryDir + "/memory.db");
    const mode = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    if (mode[0]?.journal_mode === "wal") {
      db.pragma("wal_checkpoint(TRUNCATE)");
      logInfo("main", `🧠 WAL checkpoint: ${Date.now() - t0}ms`);
    }
    db.close();
  } catch (err) {
    logError("main", `🧠 WAL checkpoint failed — DB may be corrupt: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  ctx.memory = memory;
  logInfo("main", `🧠 Memory enabled (dir=${ctx.memoryConfig.memoryDir})`);
}
