/**
 * phase-agent-api — boot phase 12: register + start Agent API service.
 *
 * Registers agent-api on ctx.registry. Starts if --agent flag set.
 *
 * Populates ctx: agentApiServer.
 * No singletons owned.
 */

import { AgentApiServer } from "../components/agent-api-server.js";
import { loadAgentApiConfig } from "../components/agent-api-config.js";
import { logInfo, logError } from "../components/logger.js";
import { sendNotification } from "../components/notification.js";
import { setPeerActivityCallback } from "../components/transport/tool-registry.js";
import type { BootCtx, PhaseResult } from "./context.js";

const TAG = "agent_api";

export async function phaseAgentApi(ctx: BootCtx): Promise<PhaseResult> {
  const { config, runtime, platforms, registry } = ctx;

  const agentConfig = loadAgentApiConfig(process.env as Record<string, string | undefined>);
  let agentApiServer: AgentApiServer | null = null;

  const { updatePeerApiState, updateDoorbellState } = await import("../components/runtime-health-snapshot.js");

  const notifyPeer = (msg: string): void => { sendNotification(ctx, msg); };
  setPeerActivityCallback(notifyPeer);

  // #978: Create A2A platform adapter (routes peer chat through Spin → Orc)
  const { AgentApiAdapter } = await import("../platforms/agent-api/agent-api-adapter.js");
  const a2aAdapter = new AgentApiAdapter();

  // Ensure stable peer identity (signingKey + tribeToken) before TLS prep
  const { bootstrapIdentity, loadPeerConfig } = await import("../components/peer-config.js");
  bootstrapIdentity();

  registry.register("agent-api", {
    configured: Boolean(agentConfig.port),
    async create() {
      // #1305: Prepare validated TLS identity before server construction.
      // Must run inside create() (not at phase level) so that Agent API can be
      // disabled without requiring OpenSSL or TLS files.
      let tlsIdentity: import("../components/peer-transport/tls-identity.js").ValidatedTlsIdentity;
      try {
        const { abtarsHome } = await import("../paths.js");
        const { join } = await import("node:path");
        const { ensureAgentApiTlsIdentity } = await import("../components/peer-transport/tls-identity.js");
        const peerConfig = loadPeerConfig();
        tlsIdentity = ensureAgentApiTlsIdentity(
          join(abtarsHome(), "config"),
          peerConfig.self.signingKey,
          peerConfig.self.name,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(TAG, `Agent API TLS identity preparation failed: ${msg}`);
        // Fail closed — no listener opens without validated TLS (#1305)
        throw err;
      }

      const { getPeerWsBroker } = await import("../components/peer-transport/peer-ws-broker.js");
      const broker = getPeerWsBroker();

      agentApiServer = new AgentApiServer({
        config: agentConfig,
        cliPath: config.transport.agentCliPath,
        workingDir: config.transport.workingDir,
        memoryRuntime: ctx.memoryRuntime,
        runtime,
        tls: tlsIdentity,
        sessionManager: ctx.sessionManager,
        onPeerActivity: notifyPeer,
        a2aAdapter,
        piExecutorService: ctx.piExecutorService,
      });

      // #1433: Wire PeerHelpService for sovereign help request handling
      try {
        const { PeerHelpService } = await import("../components/peer-help/service.js");
        const { PeerHelpStore } = await import("../components/peer-help/store.js");
        const { ContributionStore } = await import("../components/peer-help/contribution-store.js");
        const { RequesterContributionService } = await import("../components/peer-help/requester-contribution-service.js");
        const { ProjectReviewStore } = await import("../components/project-acceptance/project-review-store.js");
        const { requireTaskDatabase } = await import("../components/tasks/kanban-board.js");
        const { nerve } = await import("../components/nerve.js");
        const { kanbanEnqueue, kanbanGetCard, kanbanUpdate, kanbanList, kanbanComplete, kanbanFail } = await import("../components/tasks/kanban-board.js");
        const { getLocalCapabilities } = await import("../components/peer-transport/peer-health.js");
        const db = requireTaskDatabase();
        const reviewStore = new ProjectReviewStore(db);
        const store = new PeerHelpStore(
          db as any,
          { kanbanEnqueue, kanbanGetCard, kanbanUpdate, kanbanList, kanbanComplete, kanbanFail },
          nerve,
          { ensureAwaitingContract: (projectCardId) => reviewStore.ensureAwaitingContract(projectCardId) },
        );
        const contributionStore = new ContributionStore(db, {
          kanbanGetCard,
          kanbanUpdate,
          kanbanComplete,
          kanbanFail,
          onTerminalCommitted: (event, cardId) => nerve.fire(event, cardId),
        });
        const helpService = new PeerHelpService(store, () => getLocalCapabilities());
        helpService.setContributionStore(contributionStore);
        agentApiServer.setRequesterContributionService(new RequesterContributionService({
          taskDb: db,
          contributionStore,
          reviewStore,
          kanbanUpdate,
          kanbanFail,
        }));

        // #1357: Wire Pi executor handler for typed Pi delegation requests
        helpService.setPiHandler(async (originPeer, request, _admission) => {
          const piService = ctx.piExecutorService;
          if (!piService) {
            return { ok: false, error: "Pi executor not available on this peer" };
          }
          if (!request.target || request.target.executor !== "pi") {
            return { ok: false, error: "Not a Pi delegation request" };
          }
          try {
            // Build goal with optional context appended (#1357: pass request.context)
            const boundedGoal = request.goal.slice(0, 100_000);
            const boundedContext = request.context ? request.context.slice(0, 50_000) : "";
            const combinedGoal = boundedContext
              ? `${boundedGoal}\n\nContext: ${boundedContext}`
              : boundedGoal;

            // #1357: Reserve Pi idempotency slot before creating the run.
            // If the same request was already processed (crash recovery), return
            // the existing run identifiers instead of creating a duplicate.
            const { reserveRequest } = await import("../components/pi-request-ledger.js");
            const { canonicalRequestHash } = await import("../components/peer-help/contract.js");
            const requestHash = canonicalRequestHash(request);
            const piLedger = reserveRequest(`peer:${originPeer}`, "help.pi", request.request_id, requestHash);
            if (!piLedger.ok) {
              if (piLedger.code === "duplicate_conflict") {
                return { ok: false, error: "Request ID reused with different content (conflict)" };
              }
              // outcome_unknown: previous dispatch was started but response not persisted
              // Return error so help service marks this as unknown — origin retries later
              return { ok: false, error: "Previous Pi dispatch has unknown outcome — retry" };
            }
            if (piLedger.entry.state === "completed" && piLedger.entry.responseJson) {
              // Replay: previous PiRun already exists, return stored identifiers
              const stored = JSON.parse(piLedger.entry.responseJson) as { run_id: string; task_id: number; generation: number; session_id: string };
              return { ok: true, runId: stored.run_id, cardId: stored.task_id, generation: stored.generation, sessionId: stored.session_id };
            }

            const result = await piService.run({
              goal: combinedGoal,
              workspaceAlias: request.target.workspace_alias,
              priority: request.priority,
              deliveryPolicy: request.target.delivery,
              model: request.target.model
                ? { provider: request.target.model.provider, modelId: request.target.model.model_id, thinking: request.target.model.thinking }
                : undefined,
              owner: {
                principalId: `peer:${originPeer}`,
                origin: "peer",
                peer: originPeer,
                requestId: request.request_id,
              },
            }, { userId: `peer:${originPeer}` }, {
              clientId: `peer:${originPeer}`,
              operation: "help.pi",
              requestId: request.request_id,
              requestHash,
            });
            // #1358: persist creation facts in the owner outbox before the
            // delegation response is returned.
            const { getRemotePiProducer, getRemotePiDelivery } = await import("../components/peer-transport/remote-pi-registry.js");
            const producer = getRemotePiProducer();
            const createdRun = piService.store.get(result.runId);
            if (producer && createdRun) {
              await producer.produceEvent({ run: createdRun, kind: "accepted", originPeer, originRequestId: request.request_id });
              await producer.produceEvent({ run: createdRun, kind: "queued", originPeer, originRequestId: request.request_id });
              getRemotePiDelivery()?.pushEvents(result.runId, originPeer).catch(() => {});
            }
            return { ok: true, runId: result.runId, cardId: result.cardId, generation: result.generation, sessionId: result.sessionId };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        });

        agentApiServer.setPeerHelpService(helpService);

        // Register broker request handler for help + remote Pi wire methods
        broker.registerRequestHandler(async (peer, method, payload, _frameId) => {
          if (method === "help.request.v1") return helpService.handleHelpRequest(peer, payload);
          if (method === "help.status.v1") return helpService.handleHelpStatus(peer, payload);
          if (method === "help.withdraw.v1") return helpService.handleHelpWithdraw(peer, payload);
          if (method === "help.event.v1") return helpService.handleContributionEvent(peer, payload);
          if (method === "pi.events.list.v1" || method === "pi.events.ack.v1" || method === "pi.control.v1") {
            const { getRemotePiDelivery, getRemotePiControlHandler } = await import("../components/peer-transport/remote-pi-registry.js");
            const { wsHandlePiEventsListV1, wsHandlePiEventsAckV1, wsHandlePiControlV1 } = await import("../components/peer-transport/remote-pi-agent-api-integration.js");
            const delivery = getRemotePiDelivery();
            if (method === "pi.events.list.v1") {
              if (!delivery) throw new Error("Delivery manager not available");
              return wsHandlePiEventsListV1({ deliveryManager: delivery }, peer, payload);
            }
            if (method === "pi.events.ack.v1") {
              if (!delivery) throw new Error("Delivery manager not available");
              return wsHandlePiEventsAckV1({ deliveryManager: delivery }, peer, payload);
            }
            if (method === "pi.control.v1") {
              const controlHandler = getRemotePiControlHandler();
              if (!controlHandler) throw new Error("Control handler not available");
              return wsHandlePiControlV1({ controlHandler, deliveryManager: delivery! }, peer, `peer:${peer}`, payload);
            }
          }
          throw new Error(`Unknown help method: ${method}`);
        });

        // #1455: Unified push handler for accepted and outbound sockets
        broker.registerPushHandler(async (peer, method, payload) => {
          if (method === "peer.inventory.v1") {
            try {
              const { verifyAndStoreInventory } = await import("../components/peer-transport/peer-inventory.js");
              const { loadPeerConfig } = await import("../components/peer-config.js");
              const config = loadPeerConfig();
              const peerEntry = config.peers[peer];
              if (peerEntry?.verifyKey) {
                verifyAndStoreInventory(peer, payload as any, peerEntry.verifyKey);
              }
            } catch { /* best effort */ }
            return;
          }
          if (method === "pi.lifecycle.v1") {
            try {
              const { getRemotePiOriginReducer, getRemotePiDelivery } = await import("../components/peer-transport/remote-pi-registry.js");
              const reducer = getRemotePiOriginReducer();
              if (!reducer) return;
              const { loadPeerConfig } = await import("../components/peer-config.js");
              const localPeerName = loadPeerConfig().self.name;
              const { handlePushLifecycleEvent, authorizeRemotePiOwner } = await import("../components/peer-transport/remote-pi-agent-api-integration.js");
              const result = await handlePushLifecycleEvent({ originReducer: reducer, localPeerName, authorizeOwner: authorizeRemotePiOwner }, peer, payload as any);

              if (result.success) {
                // Send cumulative acknowledgement to the owner so it can
                // drain/compact its outbox. Fire-and-forget — if the ack
                // is lost the owner will resend on the next drain tick;
                // the duplicate handler above re-sends the ack.
                broker.sendRequest(peer, "pi.events.ack.v1", {
                  version: 1,
                  run_id: result.runId,
                  sequence: result.sequence,
                }).catch(() => {});
              } else if (result.gapDetected) {
                // Gap detected — initiate catch-up using the committed
                // latest_sequence, NOT acknowledged_sequence. Pull missing
                // events from the owner and reduce them contiguously.
                const delivery = getRemotePiDelivery();
                if (delivery) {
                  const event = payload as any;
                  const runId = event.run_id as string;
                  const latestSeq = reducer.getProjection(runId)?.latest_sequence ?? 0;
                  delivery.catchUp(
                    runId,
                    peer,
                    latestSeq,
                    async (e) => {
                      if (!reducer.reduce(e)) {
                        throw new Error(`Catch-up: failed to reduce event ${e.event_id} for run ${runId}`);
                      }
                    },
                  ).catch(() => {});
                }
              }
            } catch { /* best effort */ }
          }
        });
      } catch (err) {
        logError(TAG, `Failed to wire PeerHelpService: ${err instanceof Error ? err.message : String(err)}`);
      }

      ctx.agentApiServer = agentApiServer;
      return {
        async start() { await agentApiServer!.start(); },
        stop() { agentApiServer?.stop(); agentApiServer = null; ctx.agentApiServer = null; },
      };
    },
  });

  if (platforms.agent) {
    const result = await registry.start("agent-api");
    if (result.ok) {
      logInfo("main", `🤖 Agent API enabled on 0.0.0.0:${agentConfig.port}`);
      updatePeerApiState("listening");
    } else {
      logError("main", `Agent API failed to start: ${result.error}`);
      updatePeerApiState("failed", result.error);
    }

    // #1434, #1455: Start doorbell service + persistent outbound WS + route subscriptions
    updateDoorbellState("starting");
    import("../components/peer-transport/index.js").then(async ({ getPeerTransport, PeerDoorbellService }) => {
      const transport = getPeerTransport();
      const doorbell = new PeerDoorbellService(transport);
      transport.setDoorbell(doorbell);
      await doorbell.start();
      updateDoorbellState(doorbell.isRunning ? "listening" : "degraded", doorbell.isRunning ? undefined : "bind/start failed");
      // #1455: Start route/capability subscriptions BEFORE initWsConnections so
      // route-available events from initial outbound socket opens are captured.
      transport.start();
      if (Object.keys(loadPeerConfig().peers).length > 0) {
        await transport.initWsConnections();
      }

      // #1455: Inject broker-backed route interface into RemotePiDeliveryManager
      try {
        const { getRemotePiDelivery } = await import("../components/peer-transport/remote-pi-registry.js");
        const { getPeerWsBroker } = await import("../components/peer-transport/peer-ws-broker.js");
        const delivery = getRemotePiDelivery();
        const broker = getPeerWsBroker();
        if (delivery && typeof delivery.setRouteInterface === "function") {
          delivery.setRouteInterface({
            hasRoute: (peer: string) => broker.hasRoute(peer),
            sendPush: (peer: string, method: "pi.lifecycle.v1", payload: unknown) => broker.sendPush(peer, method, payload),
            requestConnection: (peer: string) => transport.ensurePeerConnection(peer, { reason: "outbox" }),
          });
        }
      } catch { /* best effort — Pi executor may not be loaded */ }
    }).catch((err) => {
      logError(TAG, `Peer init failed: ${err.message}`);
      updateDoorbellState("degraded", err instanceof Error ? err.message : String(err));
    });
  } else {
    updatePeerApiState("disabled");
    updateDoorbellState("disabled");
  }
  return "ran";
}
