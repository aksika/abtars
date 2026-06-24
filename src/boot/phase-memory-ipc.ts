/**
 * phase-memory-ipc — boot phase 4: wire LLM callback + start memory IPC server.
 *
 * Must run after phase-transport (needs ctx.transport for the LLM callback).
 * Must run after phase-memory (no-op if ctx.memory is null).
 *
 * - Binds memory.setLlmCall to route through ctx.transport
 * - Starts MemoryIpcServer on its own SQLite backend (out-of-proc clients)
 *
 * Owns no module-level singletons.
 */

import type { BootCtx, PhaseResult } from "./context.js";

export async function phaseMemoryIpc(ctx: BootCtx): Promise<PhaseResult> {
  if (!ctx.memory) return "skipped";

  const { MemoryIpcServer } = await import("abmind");
  const { SqliteBackend } = await import("abmind");
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
