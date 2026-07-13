import { logInfo, logError } from "../components/logger.js";
import type { BootCtx } from "./context.js";

const TAG = "boot-pi";

export async function phasePiExecutor(ctx: BootCtx): Promise<void> {
  const { loadPiConfig, validatePiWorkspaceAliases } = await import("../components/pi-executor/config.js");
  const config = loadPiConfig();
  if (!config) {
    logInfo(TAG, "Pi executor not configured — skipping");
    return;
  }

  // #1394: Validate all workspace aliases at boot.
  const aliasErrors = validatePiWorkspaceAliases(config);
  if (Object.keys(aliasErrors).length > 0) {
    for (const [alias, error] of Object.entries(aliasErrors)) {
      logError(TAG, `Workspace alias "${alias}" invalid: ${error}`);
    }
    logError(TAG, "Pi executor disabled due to invalid workspace alias(es)");
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

  const { setPiService: setReconcilerService, requestReconcile } = await import("../components/reconciler.js");
  setReconcilerService(service);

  // #1405: Boot recovery — preserve queued, interrupt active, collect queued card IDs
  const recovery = store.recoverNonterminal();
  if (recovery.interrupted > 0) {
    logInfo(TAG, `Recovered ${recovery.interrupted} active Pi run(s) — interrupted`);
  }

  ctx.piExecutorService = service;

  // #1405: Wake preserved queued Pi cards after service registration
  for (const cardId of recovery.queuedCardIds) {
    logInfo(TAG, `Waking preserved queued Pi card ${cardId}`);
    requestReconcile(cardId);
  }

  // #1360: Register Pi executor capabilities in the peer-health store
  try {
    const { getHealthStore } = await import("../components/peer-transport/peer-health.js");
    const store = getHealthStore();
    const capValues: string[] = ["pi-executor"];
    for (const alias of Object.keys(config.workspaceAliases)) {
      const normalized = alias.toLowerCase().replace(/[^a-z0-9_.\-]/g, "-");
      capValues.push(`workspace:${normalized}`);
    }
    store.capabilities.register("pi-executor-boot", capValues);
  } catch { /* best effort */ }

  logInfo(TAG, `Pi executor ready (${config.command}, ${Object.keys(config.workspaceAliases).length} aliases)`);
}
