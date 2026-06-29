/**
 * phase-memory-ipc — boot phase 4: wire LLM callback + start memory IPC server.
 *
 * Must run after phase-transport (needs ctx.transport for the LLM callback).
 * Must run after phase-memory (no-op if abmind not installed).
 *
 * - Binds memory.setLlmCall to route through ctx.transport
 * - Starts MemoryIpcServer on its own SQLite backend (out-of-proc clients)
 *
 * Owns no module-level singletons.
 */

import type { BootCtx, PhaseResult } from "./context.js";
import { abmind, loadAbmind } from "../utils/abmind-lazy.js";

export async function phaseMemoryIpc(ctx: BootCtx): Promise<PhaseResult> {
  const mod = abmind() ?? await loadAbmind();
  if (!mod) return "skipped";

  const { MemoryIpcServer, SqliteBackend } = mod;
  const ipcBackend = new SqliteBackend(ctx.memoryConfig);
  await ipcBackend.initialize();
  const memoryIpc = new MemoryIpcServer(ipcBackend);

  // Wire ActionGate for auth-request IPC calls from external CLI
  if (ctx.actionGate) {
    memoryIpc.setUnknownMethodHandler(async (method: string, params: unknown) => {
      if (method === "auth-request" && ctx.actionGate) {
        const { category, detail } = params as { category: string; detail: string };
        const granted = await ctx.actionGate.requestAuth(category, detail || "");
        return { granted };
      }
      throw new Error(`Unknown method: ${method}`);
    });
  }

  await memoryIpc.start();
  return "ran";
}
