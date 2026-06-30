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
 *
 * #1243: abmind is discovered at runtime from the GLOBAL install, not bundled
 * in the release. A legacy release may still carry a bundled abmind — its
 * presence without a resolvable global abmind means a half-migrated host that
 * would SILENTLY lose memory; we refuse to degrade silently in that case.
 */

import { logDebug, logInfo, logWarn, logError } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { nullMemory } from "../components/null-memory.js";
import { loadAbmind } from "../utils/abmind-lazy.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export async function phaseMemory(ctx: BootCtx): Promise<PhaseResult> {
  const home = process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars");

  // Legacy bundled-abmind paths (pre-#1243). Under #1243 these should not exist
  // in a fresh release; their presence signals a migrating host.
  const legacyAbmindPkgs = [
    join(home, "app", "bundle", "node_modules", "abmind", "package.json"),
    join(home, "app", "node_modules", "abmind", "package.json"),
  ].filter(p => existsSync(p));

  const mod = await loadAbmind();

  // #864 (preserved): two bundled abminds → dual DB connections → silent corruption.
  if (legacyAbmindPkgs.length > 1) {
    logError("boot", `FATAL: duplicate bundled abmind at ${legacyAbmindPkgs.map(p => p.replace("/package.json", "")).join(" + ")}. Delete one to prevent dual DB connections. Refusing to start.`);
    process.exit(1);
  }

  // #1243 migration guard: a legacy bundled abmind is present but no global
  // abmind resolves. Don't silently fall back to nullMemory — that hides a lost
  // subsystem. Demand the global install first.
  if (legacyAbmindPkgs.length === 1 && !mod) {
    logError("boot", `FATAL: legacy bundled abmind at ${legacyAbmindPkgs[0]!.replace("/package.json", "")} but no global abmind is resolvable. #1243 ships abmind separately — install it first: npm install -g abmind@latest. Refusing to start without memory.`);
    process.exit(1);
  }

  if (!mod) {
    // No bundled abmind and none installed → genuinely optional. loadAbmind()
    // already logged the precise reason; degrade quietly.
    ctx.memory = nullMemory;
    ctx.memoryConfig.memoryEnabled = false;
    ctx.memoryConfig.memoryDir = "";
    return "skipped";
  }

  if (!ctx.memoryConfig.memoryEnabled) {
    logInfo("main", "🧠 Memory disabled");
    ctx.memory = nullMemory;
    ctx.memoryConfig.memoryDir = "";
    return "skipped";
  }

  try {
    const memory = new mod.MemoryManager(ctx.memoryConfig);
    await memory.initialize();
    ctx.memory = memory;
    logDebug("main", `🧠 Memory enabled (dir=${ctx.memoryConfig.memoryDir})`);

    // #1266: Wire in-process memory to the tool registry, transport-agnostic.
    // #860: Use the SAME MemoryManager instance — don't create a second SqliteBackend.
    // Two separate DB connections to the same WAL-mode file corrupt each other's handles.
    const { setMemoryBackend } = await import("../components/transport/tool-registry.js");
    const mm = ctx.memory!;
    const backend = {
      initialize: async () => {},
      close: () => {},
      instantStore: (p: any) => mm.editor.instantStore(p),
      editMemory: (p: any) => mm.editor.editMemory(p),
      reclassifyMemory: (id: number, level: number, uo: boolean) => { mm.editor.reclassifyMemory(id, level, uo); return Promise.resolve(); },
      adjustRelevance: (id: number, delta: number) => { mm.editor.adjustRelevance(id, delta); return Promise.resolve(); },
      mergeMemories: (a: number, b: number) => mm.editor.mergeMemories(a, b),
      cascadeDelete: (ids: number[], uid: string) => mm.editor.cascadeDelete(ids, uid),
      recall: (p: any) => mm.recallSearch(p),
      rebuildFtsIndexes: () => mm.rebuildFtsIndexes(),
    };
    setMemoryBackend(backend as any);
    logInfo("main", "🧠 In-process memory wired to tool registry (shared handle)");

    return "ran";
  } catch (err) {
    logWarn("main", `⚠️ Memory init failed: ${err instanceof Error ? err.message : String(err)}. Running without persistent memory.`);
    ctx.memory = nullMemory;
    ctx.memoryConfig.memoryEnabled = false;
    ctx.memoryConfig.memoryDir = "";
    return "skipped";
  }
}
