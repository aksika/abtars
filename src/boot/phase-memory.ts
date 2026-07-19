/**
 * phase-memory — boot phase 2: initialize memory layer.
 *
 * - no-ops if memoryConfig.memoryEnabled is false
 * - wires setMemoryLogger
 * - connects to abmind daemon via AbmindClient; falls back to embedded
 *   MemoryManager when daemon is unavailable (#1380)
 *
 * Populates ctx: client (AbmindClient or null), memory (MemoryManager or null).
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
  const home = process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars");

  const legacyAbmindPkgs = [
    join(home, "app", "bundle", "node_modules", "abmind", "package.json"),
    join(home, "app", "node_modules", "abmind", "package.json"),
  ].filter(p => existsSync(p));

  const mod = await loadAbmind();
  ctx.abmindModule = mod;

  if (legacyAbmindPkgs.length > 1) {
    logError("boot", `FATAL: duplicate bundled abmind at ${legacyAbmindPkgs.map(p => p.replace("/package.json", "")).join(" + ")}. Delete one to prevent dual DB connections. Refusing to start.`);
    process.exit(1);
  }

  if (legacyAbmindPkgs.length === 1 && !mod) {
    logError("boot", `FATAL: legacy bundled abmind at ${legacyAbmindPkgs[0]!.replace("/package.json", "")} but no global abmind is resolvable. #1243 ships abmind separately — install it first: npm install -g abmind@latest. Refusing to start without memory.`);
    process.exit(1);
  }

  if (!mod) {
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

  // #1380: daemon required. No fallback — getMemoryClient(true) throws if unavailable.
  try {
    const { getMemoryClient, isClient } = mod;
    const mem = await getMemoryClient(true, ctx.memoryConfig);

    ctx.client = mem as any;
    logInfo("main", "🧠 Memory enabled via abmind daemon");

    const { setMemoryBackend } = await import("../components/transport/tool-registry.js");
    const backend = isClient(mem)
      ? {
          initialize: async () => {},
          close: () => mem.close().catch(() => {}),
          instantStore: (p: any) => mem.privateMemory.instantStore(p),
          editMemory: (p: any) => mem.privateMemory.editMemory(p),
          reclassifyMemory: (id: number, level: number, uo: boolean) => mem.privateMemory.reclassifyMemory(id, level, uo),
          adjustRelevance: (id: number, delta: number) => mem.privateMemory.adjustRelevance(id, delta),
          mergeMemories: (a: number, b: number) => mem.privateMemory.mergeMemories(a, b),
          cascadeDelete: (ids: number[], uid: string) => mem.privateMemory.cascadeDelete(ids, uid),
          recall: (p: any) => mem.privateMemory.recall(p),
          rebuildFtsIndexes: () => mem.privateMemory.rebuildFtsIndexes(),
        }
      : {
          initialize: async () => {},
          close: () => mem.close(),
          instantStore: (p: any) => mem.editor.instantStore(p),
          editMemory: (p: any) => mem.editor.editMemory(p),
          reclassifyMemory: (id: number, level: number, uo: boolean) => { mem.editor.reclassifyMemory(id, level, uo); return Promise.resolve(); },
          adjustRelevance: (id: number, delta: number) => { mem.editor.adjustRelevance(id, delta); return Promise.resolve(); },
          mergeMemories: (a: number, b: number) => mem.editor.mergeMemories(a, b),
          cascadeDelete: (ids: number[], uid: string) => mem.editor.cascadeDelete(ids, uid),
          recall: (p: any) => mem.recallSearch(p),
          rebuildFtsIndexes: () => mem.rebuildFtsIndexes(),
        };
    setMemoryBackend(backend as any);
    logInfo("main", isClient(mem)
      ? "🧠 Daemon-backed memory wired to tool registry"
      : "🧠 In-process memory wired to tool registry (shared handle)");

    return "ran";
  } catch (err) {
    logWarn("main", `⚠️ Memory init failed: ${err instanceof Error ? err.message : String(err)}. Running without persistent memory.`);
    ctx.client = null;
    ctx.memory = nullMemory;
    ctx.memoryConfig.memoryEnabled = false;
    ctx.memoryConfig.memoryDir = "";
    return "skipped";
  }
}
