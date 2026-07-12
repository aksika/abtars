import { logInfo, logError } from "../components/logger.js";
import type { BootCtx } from "./context.js";

const TAG = "boot-pi";

export async function phasePiExecutor(ctx: BootCtx): Promise<void> {
  const { loadPiConfig } = await import("../components/pi-executor/config.js");
  const config = loadPiConfig();
  if (!config) {
    logInfo(TAG, "Pi executor not configured — skipping");
    return;
  }

  const { PiRunStore } = await import("../components/pi-executor/pi-run-store.js");
  const { PiExecutor } = await import("../components/pi-executor/pi-executor.js");
  const { PiRunService } = await import("../components/pi-executor/pi-run-service.js");

  let db: import("better-sqlite3").Database | null = null;
  try {
    const { resolveNativeDep } = await import("../utils/lazy-require.js");
    const Database = resolveNativeDep("better-sqlite3") as typeof import("better-sqlite3").default;
    db = new Database(":memory:") as unknown as import("better-sqlite3").Database;
  } catch {
    logError(TAG, "better-sqlite3 not available — Pi executor requires it");
    return;
  }

  const store = new PiRunStore({
    db: {
      prepare(sql: string) {
        const stmt = db!.prepare(sql);
        return {
          run(...params: unknown[]) { const r = stmt.run(...params); return { changes: r.changes }; },
          get(...params: unknown[]) { return stmt.get(...params) as Record<string, unknown> | undefined; },
          all(...params: unknown[]) { return stmt.all(...params) as Record<string, unknown>[]; },
        };
      },
      transaction<T>(fn: () => T): T { return db!.transaction(fn)(); },
    },
  });

  const executor = new PiExecutor(config, store);
  const service = new PiRunService({
    store,
    executor,
    config,
    spin: ctx.sessionManager!,
  });

  const { setPiService: setCmdService } = await import("../components/commands/handlers-pi.js");
  setCmdService(service);

  const { setPiService: setReconcilerService } = await import("../components/reconciler.js");
  setReconcilerService(service);

  const activeRuns = store.findNonTerminal();
  for (const run of activeRuns) {
    store.casTransition(run.id, run.status as any, "interrupted", {
      resumeCapability: run.piSessionId ? "available" : "never_started",
    });
    logInfo(TAG, `Interrupted Pi run ${run.id} (was ${run.status})`);
  }

  ctx.piExecutorService = service;
  logInfo(TAG, `Pi executor ready (${config.command}, ${Object.keys(config.workspaceAliases).length} aliases)`);
}
