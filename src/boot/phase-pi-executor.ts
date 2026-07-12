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

  const { requireTaskDatabase } = await import("../components/tasks/kanban-board.js");

  let taskDb: import("../components/tasks/kanban-board.js").TaskDatabase;
  try {
    taskDb = requireTaskDatabase();
  } catch (err) {
    logError(TAG, `Kanban database unavailable — Pi executor requires it: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Enable foreign-key enforcement (safe after kanban migrations, before Pi migrations)
  taskDb.exec("PRAGMA foreign_keys = ON");

  const { PiRunStore } = await import("../components/pi-executor/pi-run-store.js");
  const { PiExecutor } = await import("../components/pi-executor/pi-executor.js");
  const { PiRunService } = await import("../components/pi-executor/pi-run-service.js");

  const store = new PiRunStore({ db: taskDb });

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
