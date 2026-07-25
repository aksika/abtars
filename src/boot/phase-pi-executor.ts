import { logInfo, logWarn, logError } from "../components/logger.js";
import type { BootCtx } from "./context.js";
import { resolvePiInstallation } from "../components/pi-installation.js";
import { PI_COMPATIBILITY } from "../config/pi-compatibility.js";

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

  // #1438: Use shared installation resolver for executable + version check
  const piResult = resolvePiInstallation();
  if (piResult.state !== "compatible") {
    const obsVer = piResult.state === "absent" ? "" : ` (version ${piResult.observedVersion ?? "?"})`;
    logWarn(TAG, `Pi executor disabled — Pi ${piResult.state}${obsVer}. Minimum required: ${PI_COMPATIBILITY.minimumPiVersion}`);
    if (piResult.state !== "absent" && piResult.remediation) logWarn(TAG, piResult.remediation);
    return;
  }
  logInfo(TAG, `Pi ${piResult.installation.version} (${piResult.installation.source})`);

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

  // #1358 — Construct remote Pi lifecycle components and wire transition hook
  let localPeerName = "local";
  try {
    const { loadPeerConfig } = await import("../components/peer-config.js");
    localPeerName = loadPeerConfig().self.name;
  } catch { /* peer config may not exist in standalone Pi mode */ }

  const { RemotePiEventProducer } = await import("../components/peer-transport/remote-pi-event-producer.js");
  const { RemotePiDeliveryManager } = await import("../components/peer-transport/remote-pi-delivery.js");
  const { RemotePiControlHandler } = await import("../components/peer-transport/remote-pi-control-handler.js");
  const { RemotePiOriginReducer, SqliteProjectionStore } = await import("../components/peer-transport/remote-pi-origin-projection.js");
  const { setRemotePiComponents } = await import("../components/peer-transport/remote-pi-registry.js");

  const eventProducer = new RemotePiEventProducer({ store });
  const deliveryManager = new RemotePiDeliveryManager({ store, eventProducer, localPeerName });
  const controlHandler = new RemotePiControlHandler({ store, service, eventProducer });
  const originReducer = new RemotePiOriginReducer(new SqliteProjectionStore(taskDb), (projection, event) => {
    // #1358: keep the single #1357 origin card as the user-visible projection.
    // Kanban has no interrupted/awaiting-input states, so those remain active.
    const cardStatus = projection.latest_status === "completed"
      ? "done"
      : ["failed", "cancelled"].includes(projection.latest_status)
        ? "failed"
        : projection.latest_status === "queued" ? "queued" : "running";
    const sets = ["status = ?", "updated_at = datetime('now')"];
    const values: unknown[] = [cardStatus];
    if (["done", "failed"].includes(cardStatus)) sets.push("completed_at = datetime('now')");
    if (projection.result_summary !== undefined) { sets.push("result_summary = ?"); values.push(projection.result_summary); }
    if (projection.error_summary !== undefined) { sets.push("error = ?"); values.push(projection.error_summary); }
    if (event.kind === "resumed") { sets.push("result_summary = NULL", "error = NULL", "completed_at = NULL"); }
    // The event card_id is the owner's Pi card. Resolve the origin-side
    // delegation card by the durable remote run reference instead of ever
    // mutating the owner's card ID in this process.
    const localCard = (taskDb.prepare(`SELECT id, notes FROM kanban_board WHERE source = 'peer'`).all() as Array<{ id: number; notes?: string | null }>).find((row) => {
      try { return (JSON.parse(row.notes ?? "{}") as Record<string, unknown>).remote_run_id === projection.run_id; } catch { return false; }
    });
    if (!localCard) return;
    values.push(localCard.id);
    taskDb.prepare(`UPDATE kanban_board SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  });

  setRemotePiComponents({ eventProducer, delivery: deliveryManager, controlHandler, originReducer });

  // Wire the PiExecutor transition hook to produce lifecycle events.
  // Only runs for delegated runs (origin_peer set).
  executor.onTransition((runId, _fromStatus, _toStatus) => {
    const run = store.get(runId);
    if (!run || !run.originPeer) return; // not a delegated run
    eventProducer.produceFromTransition({
      run,
      previousStatus: _fromStatus,
      originPeer: run.originPeer,
      originRequestId: run.originRequestId ?? run.originChatId ?? run.id,
    }).then(() => {
      // Attempt immediate WS push after producing
      deliveryManager.pushEvents(runId, run.originPeer!).catch(() => {});
    }).catch(err => {
      logError(TAG, `Failed to produce lifecycle event for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  executor.onProgress((runId, progressPayload) => {
    const run = store.get(runId);
    if (!run?.originPeer) return;
    eventProducer.produceProgress({
      run,
      originPeer: run.originPeer,
      originRequestId: run.originRequestId ?? run.originChatId ?? run.id,
      progressPayload,
    }).then(() => deliveryManager.pushEvents(runId, run.originPeer!).catch(() => {})).catch(err => {
      logError(TAG, `Failed to produce progress event for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    });
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

  // #1358: Startup recovery — push unacknowledged remote Pi events for all
  // delegated runs. On restart, events produced before the crash are still
  // in the outbox (unacknowledged). This scan ensures they reach the origin
  // after the first WSS connection becomes available.
  try {
    await eventProducer.recoverMissingEvents();
    const pending = store.findRunsWithUnacknowledgedEvents();
    if (pending.length > 0) {
      logInfo(TAG, `Remote Pi recovery: ${pending.length} run(s) with unacknowledged events`);
      for (const row of pending) {
        deliveryManager.pushEvents(row.run_id, row.origin_peer).catch(() => {});
      }
    }
  } catch (err) {
    logError(TAG, `Remote Pi event recovery scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // #1360: Register Pi executor capabilities in the peer-health store
  try {
    const { getHealthStore } = await import("../components/peer-transport/peer-health.js");
    const healthStore = getHealthStore();
    const capValues: string[] = ["pi-executor"];
    for (const alias of Object.keys(config.workspaceAliases)) {
      const normalized = alias.toLowerCase().replace(/[^a-z0-9_.\-]/g, "-");
      capValues.push(`workspace:${normalized}`);
    }
    // #1357: Capture the disposer for clean withdrawal on shutdown
    const disposePiCaps = healthStore.register("pi-executor-boot", capValues);
    ctx._piCapDisposer = disposePiCaps;
  } catch { /* best effort */ }

  logInfo(TAG, `Pi executor ready (${config.command}, ${Object.keys(config.workspaceAliases).length} aliases)`);
}
