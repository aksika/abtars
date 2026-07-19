/**
 * phase-memory — boot phase 2: initialize memory layer.
 *
 * - no-ops if memoryConfig.memoryEnabled is false
 * - wires setMemoryLogger
 * - connects to the abmind daemon via AbmindClient; unavailable remains
 *   explicitly degraded (#1380)
 *
 * Populates ctx: client (AbmindClient or null), memoryRuntime.
 *
 * Owns no module-level singletons (setMemoryLogger is a setter on abmind's
 * internal logger, not an abtars singleton).
 */

import { logInfo, logWarn, logError } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { loadAbmind } from "../utils/abmind-lazy.js";
import { createClientRuntime, createDisabledRuntime, createUnavailableRuntime } from "../components/memory-runtime.js";
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
    ctx.memoryRuntime = createDisabledRuntime();
    return "skipped";
  }

  if (!ctx.memoryConfig.memoryEnabled) {
    logInfo("main", "🧠 Memory disabled");
    ctx.memoryRuntime = createDisabledRuntime();
    return "skipped";
  }

  // #1380: daemon required. No fallback — getMemoryClient(true) throws if unavailable.
  try {
    const { getMemoryClient } = mod;
    const mem = await getMemoryClient(true, ctx.memoryConfig);

    const client = mem as import("abmind").AbmindClient;
    ctx.client = client;
    ctx.memoryRuntime = createClientRuntime(client);
    logInfo("main", "🧠 Memory enabled via abmind daemon");

    const { setMemoryBackend } = await import("../components/transport/tool-registry.js");
    const backend = {
      initialize: async () => {},
      close: () => client.close().catch(() => {}),
      instantStore: (p: any) => client.privateMemory.instantStore(p),
      editMemory: (p: any) => client.privateMemory.editMemory(p),
      reclassifyMemory: (id: number, level: number, uo: boolean) => client.privateMemory.reclassifyMemory(id, level, uo),
      adjustRelevance: (id: number, delta: number) => client.privateMemory.adjustRelevance(id, delta),
      mergeMemories: (a: number, b: number) => client.privateMemory.mergeMemories(a, b),
      cascadeDelete: (ids: number[], uid: string) => client.privateMemory.cascadeDelete(ids, uid),
      recall: (p: any) => client.privateMemory.recall(p),
      rebuildFtsIndexes: () => client.privateMemory.rebuildFtsIndexes(),
    };
    setMemoryBackend(backend as any);
    logInfo("main", "🧠 Daemon-backed memory wired to tool registry");

    return "ran";
  } catch (err) {
    logWarn("main", `⚠️ Memory init failed: ${err instanceof Error ? err.message : String(err)}. Running without persistent memory.`);
    ctx.client = null;
    ctx.memoryRuntime = createUnavailableRuntime();
    return "skipped";
  }
}
