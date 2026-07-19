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
import { sendToMainChat } from "../components/main-chat.js";
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
        onPiNotify: (text) => sendToMainChat(
          { telegram: ctx.telegramAdapter, discord: ctx.discordAdapter },
          text,
        ),
        piExecutorService: ctx.piExecutorService,
      });

      // #1433: Wire PeerHelpService for sovereign help request handling
      try {
        const { PeerHelpService } = await import("../components/peer-help/service.js");
        const { PeerHelpStore } = await import("../components/peer-help/store.js");
        const { requireTaskDatabase } = await import("../components/tasks/kanban-board.js");
        const { nerve } = await import("../components/nerve.js");
        const { kanbanEnqueue, kanbanGetCard, kanbanUpdate, kanbanList, kanbanComplete, kanbanFail } = await import("../components/tasks/kanban-board.js");
        const { getLocalCapabilities } = await import("../components/peer-transport/peer-health.js");
        const db = requireTaskDatabase();
        const store = new PeerHelpStore(
          db as any,
          { kanbanEnqueue, kanbanGetCard, kanbanUpdate, kanbanList, kanbanComplete, kanbanFail },
          nerve,
        );
        const helpService = new PeerHelpService(store, () => getLocalCapabilities());
        agentApiServer.setPeerHelpService(helpService);

        // Register broker request handler for help wire methods
        broker.registerRequestHandler(async (peer, method, payload, _frameId) => {
          if (method === "help.request.v1") return helpService.handleHelpRequest(peer, payload);
          if (method === "help.status.v1") return helpService.handleHelpStatus(peer, payload);
          if (method === "help.withdraw.v1") return helpService.handleHelpWithdraw(peer, payload);
          if (method === "help.event.v1") return helpService.handleContributionEvent(peer, payload);
          throw new Error(`Unknown help method: ${method}`);
        });

        // Register push handler for broker (inventory, etc.)
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
      if (Object.keys(loadPeerConfig().peers).length > 0) {
        await transport.initWsConnections();
      }
      // #1455: Start route and capability subscriptions (inventory send, remote-pi drain)
      transport.start();
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
