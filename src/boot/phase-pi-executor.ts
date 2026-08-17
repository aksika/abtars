import { logInfo, logWarn, logError } from "../components/logger.js";
import { logAndSwallow } from "../components/log-and-swallow.js";
import type { BootCtx } from "./context.js";
import { resolvePiInstallation } from "../components/pi-installation.js";
import { PI_COMPATIBILITY, formatPiPinWarning } from "../config/pi-compatibility.js";

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
    logWarn(TAG, `Pi executor disabled — Pi ${piResult.state}${obsVer}. Pinned version: ${PI_COMPATIBILITY.pinnedVersion}`);
    if (piResult.state !== "absent" && piResult.remediation) logWarn(TAG, piResult.remediation);
    return;
  }
  logInfo(TAG, `Pi ${piResult.installation.version} (${piResult.installation.source})`);
  if (piResult.installation.pinStatus === "above-pin") {
    const pinWarning = formatPiPinWarning(piResult.installation.version);
    if (pinWarning) logWarn(TAG, pinWarning.split("\n").join("; "));
  }

  const { requireTaskDatabase } = await import("../components/tasks/kanban-board.js");
  const { kanbanTransition, sqliteNow } = await import("../components/tasks/kanban-board.js");

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

  const store = new PiRunStore({ db: taskDb, sessionStorageRoot: config.sessionStorageRoot });

  const executor = new PiExecutor(config, store);
  // #1647 — generation-fenced external C session closer, wired from spin.
  executor.setExternalSessionCloser((sessionId, expected) => {
    try {
      return ctx.sessionManager!.endExternalSession(sessionId, expected);
    } catch {
      return false;
    }
  });
  const service = new PiRunService({
    store,
    executor,
    config,
    spin: ctx.sessionManager!,
  });

  // #1635 — interactive Pi coding sessions: durable store + claim seam + the
  // session service. Wired after the executor so the shared host is the same
  // instance that gates /pi run capacity.
  try {
    const { PiCodingSessionStore } = await import("../components/pi-executor/pi-coding-session-store.js");
    const { PiWorkspaceClaimStore } = await import("../components/pi-executor/pi-workspace-claim-store.js");
    const { PiCodingSessionService } = await import("../components/pi-executor/pi-coding-session-service.js");
    const { setCodingRouteService } = await import("../components/pipeline/coding-route.js");
    const { setCodingCommandService } = await import("../components/commands/handlers-coding.js");
    const { createCodingProjectionSink, setCodingCallbackHandler } = await import("../platforms/telegram/telegram-coding-projection.js");

    const codingStore = new PiCodingSessionStore(taskDb);
    const claimStore = new PiWorkspaceClaimStore(taskDb);
    const codingService = new PiCodingSessionService({
      store: codingStore,
      claims: claimStore,
      host: executor.host,
      config,
      spin: ctx.sessionManager!,
      sink: createCodingProjectionSink(codingStore),
    });

    // #1635 — restart reconciliation: interrupt live rows with proof-derived
    // capabilities and clear stale leases/claims.
    codingService.reconcileOnBoot();

    setCodingRouteService(codingService);
    setCodingCommandService(codingService);
    ctx.sessionManager!.setCodingSessionTeardown((sessionId) => {
      return codingService.prepareEndSession(sessionId);
    });
    setCodingCallbackHandler(async (sessionId, requestId, value, chatId) => {
      const rec = codingStore.get(sessionId);
      if (!rec) return false;
      // Telegram callback payloads are untrusted. The durable chat target is
      // the second ownership fence in addition to the service's user fence.
      if (rec.chatId !== String(chatId)) return false;
      const coerced = value === "true" ? true : value === "false" ? false : value;
      const result = await codingService.reply(sessionId, requestId, coerced, rec.ownerPrincipal);
      return result.ok;
    });
    ctx.codingSessionService = codingService;
    logInfo(TAG, `Interactive Pi coding sessions ready`);
  } catch (err) {
    logWarn(TAG, `Interactive Pi coding sessions unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

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
  const originReducer = new RemotePiOriginReducer(new SqliteProjectionStore(taskDb), (projection, event) => {    // #1358: keep the single #1357 origin card as the user-visible projection.
    // Kanban has no interrupted/awaiting-input states, so those remain active.
    // On `resumed` the producer sends run.status="queued", so the projection
    // re-asserts `queued` — not `running` as an earlier draft assumed.
    const cardStatus = projection.latest_status === "completed"
      ? "done"
      : ["failed", "cancelled"].includes(projection.latest_status)
        ? "failed"
        : projection.latest_status === "queued" ? "queued" : "running";
    // The event's remote_card_id is the owner's Pi card. Resolve the origin-side
    // delegation card by the durable remote run reference instead of ever
    // mutating the owner's card ID in this process.
    const localCard = (taskDb.prepare(`SELECT id, notes FROM kanban_board WHERE source = 'peer'`).all() as Array<{ id: number; notes?: string | null }>).find((row) => {
      try { return (JSON.parse(row.notes ?? "{}") as Record<string, unknown>).remote_run_id === projection.run_id; } catch { return false; }
    });
    if (!localCard) return;
    // #1590: through the single transition helper. from is every status the
    // computed target legally accepts; same-status events re-assert (fields
    // applied, no journal row). The projection fired no nerve events before
    // and emits none now.
    const fields: Record<string, unknown> = {};
    if (["done", "failed"].includes(cardStatus)) fields.completed_at = sqliteNow();
    if (projection.result_summary !== undefined) fields.result_summary = projection.result_summary;
    if (projection.error_summary !== undefined) fields.error = projection.error_summary;
    if (event.kind === "resumed") {
      fields.result_summary = null;
      fields.error = null;
      fields.completed_at = null;
    }
    // from is every status the computed target legally accepts per the #1590
    // matrix — including the pairs the task-run-settler path added
    // (queued→done, done→failed), so a queued/failed delegation card receiving
    // a late event re-settles instead of throwing.
    const FROM_FOR_TARGET: Record<string, readonly string[]> = {
      queued: ["running", "failed", "done"],
      running: ["queued"],
      done: ["running", "delivering", "queued"],
      failed: ["queued", "running", "done"],
    };
    // `to` is appended so same-status events re-assert (fields applied, no
    // journal row) instead of no-op'ing — the design's reassertion contract.
    const from = [...(FROM_FOR_TARGET[cardStatus] ?? ["queued"]), cardStatus];
    kanbanTransition({
      cardId: localCard.id,
      from: [...new Set(from)] as readonly import("../components/tasks/kanban-board.js").CardStatus[],
      to: cardStatus,
      actor: "pi_origin_projection",
      reason: "remote origin projection",
      fields,
      emit: false,
    }, taskDb);
  });

  setRemotePiComponents({ eventProducer, delivery: deliveryManager, controlHandler, originReducer });

  // #1358 review — mechanism A: the store emits lifecycle events inside the
  // SAME transaction as each public run transition (see pi-run-store.ts
  // transition methods). The transition hooks below therefore only trigger
  // opportunistic WSS push — they never produce events after commit, because
  // a crash between commit and append would lose the event, and snapshot
  // scanning is not a durability mechanism.
  store.setRemoteEventEmitter(eventProducer);

  // Wire the PiExecutor transition hook to trigger delivery only.
  executor.onTransition((runId, _fromStatus, _toStatus) => {
    const run = store.get(runId);
    if (!run || !run.originPeer) return; // not a delegated run
    deliveryManager.pushEvents(runId, run.originPeer!).catch(err => logAndSwallow(TAG, "push events after transition", err));
  });

  executor.onProgress((runId, progressPayload) => {
    const run = store.get(runId);
    if (!run?.originPeer) return;
    eventProducer.produceProgress({
      run,
      originPeer: run.originPeer,
      originRequestId: run.originRequestId ?? run.originChatId ?? run.id,
      progressPayload,
    }).then(() => deliveryManager.pushEvents(runId, run.originPeer!).catch(err => logAndSwallow(TAG, "push events after progress", err))).catch(err => {
      logError(TAG, `Failed to produce progress event for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  const { setPiService: setCmdService } = await import("../components/commands/handlers-pi.js");
  setCmdService(service);

  // #1638: advisory Pi capacity view for check_workers
  try {
    const { setPiCapacityService } = await import("../components/pi-capacity-view.js");
    setPiCapacityService(service);
  } catch { /* best effort */ }

  // #1554: the Reconciler receives the Pi service through its phase-reconciler
  // composition (ctx.piExecutorService) — no reconciler setter wiring here.
  // Capacity-release and progress callbacks below keep using the stable
  // request façade, which targets the active generation at call time.
  const { requestReconcile, requestWorkerDispatch } = await import("../components/reconciler.js");

  // Kept outside the wiring try so boot recovery can route supervised
  // interruptions through the same Worker-owned settlement authority.
  let settleSupervisedRecovery: ((runId: string, generation: number) => unknown) | null = null;

  // #1638: supervised/standalone terminal router. Every Pi process terminal
  // observation goes through the coordinator; supervised runs settle through
  // the Worker attempt, standalone runs keep their own card settlement.
  try {
    const { SupervisedPiSettlement } = await import("../components/pi-executor/supervised-pi-settlement.js");
    const { WorkerSupervisionStore } = await import("../components/worker-supervision-store.js");
    const workerSupervision = new WorkerSupervisionStore(taskDb);
    const coordinator = new SupervisedPiSettlement(store, workerSupervision, config);
    // #1643: one communication component on the same stores/DB identity —
    // routes typed tell_orc tool frames to the durable root channel.
    const { SupervisedPiCommunication } = await import("../components/pi-executor/supervised-pi-communication.js");
    executor.setCommunicationPort(new SupervisedPiCommunication(store, workerSupervision));
    settleSupervisedRecovery = (runId, generation) => coordinator.settlePiExecution({
      runId,
      generation,
      outcome: "failed",
      metadata: { error: "interrupted by bridge restart" },
    });
    executor.setSettlementRouter((observation) => coordinator.settlePiExecution(observation));
    // #1647 — typed interruption routing: standalone goes through the paired
    // store operation, supervised settles the Worker attempt in the same
    // transaction (the W card stays Worker-owned).
    executor.setInterruptRouter((input) => coordinator.interruptPiExecution(input));
    // #1638: a supervised Pi input request suspends the run and settles the
    // attempt as input_requested (structured question evidence, zero charge).
    executor.setInputSuspendHook(async (runId, generation, request) => {
      const run = store.get(runId);
      if (!run) return false;
      // only supervised runs suspend — standalone keeps awaiting_input
      const binding = workerSupervision.getAttemptForExecutorResource("pi", runId, generation);
      if (!binding) return false;
      // #1643: an input dialog carries the question in `placeholder` (the
      // ask_orc extension sends exactly title="Ask Orc" + placeholder=question);
      // select/confirm/editor dialogs carry it in message/title.
      const req = request as { method?: string; message?: unknown; title?: unknown; placeholder?: unknown };
      const primary = req.method === "input" ? req.placeholder : req.message;
      const question = String(primary ?? req.title ?? "input requested");
      const sessionFile = run.piSessionFile ?? undefined;
      const outcome = coordinator.suspendForInput({ runId, generation, question, requestId: request.id ?? `req_${Date.now()}`, sessionFile });
      if (outcome.suspended) {
        logInfo(TAG, `Supervised Pi run ${runId} suspended for input (gen ${generation}) — Worker attempt settled input_requested`);
        try { requestWorkerDispatch(); } catch { /* best effort */ }
      }
      return outcome.suspended;
    });
  } catch (err) {
    logWarn(TAG, `Supervised Pi settlement coordinator unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // #1638: shared post-release wake — every Pi capacity/workspace release
  // fans out to supervised Worker dispatch AND queued standalone Pi cards.
  // Advisory + idempotent; runs only after the release transaction (and
  // owned-process cleanup). Periodic/boot reconciliation is the floor.
  executor.onCapacityReleased(() => {
    try {
      requestWorkerDispatch();
      for (const cardId of store.findQueuedPiCardIds()) {
        requestReconcile(cardId);
      }
    } catch (err) {
      logWarn(TAG, `Post-release wake failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // #1405: Boot recovery — preserve queued, interrupt active, collect queued card IDs
  const recovery = store.recoverNonterminal();
  if (recovery.interrupted > 0) {
    logInfo(TAG, `Recovered ${recovery.interrupted} active Pi run(s) — interrupted`);
  }
  for (const runId of recovery.supervisedInterruptedRunIds ?? []) {
    const run = store.get(runId);
    if (!run) continue;
    const result = settleSupervisedRecovery?.(runId, run.executionGeneration);
    if (!result) {
      logWarn(TAG, `Supervised Pi recovery for ${runId} could not reach the Worker settlement coordinator`);
    }
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
        deliveryManager.pushEvents(row.run_id, row.origin_peer).catch(err => logAndSwallow(TAG, "recovery push", err));
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
