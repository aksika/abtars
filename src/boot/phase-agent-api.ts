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
import { logAndSwallow } from "../components/log-and-swallow.js";
import { logInfo, logError } from "../components/logger.js";
import { sendNotification } from "../components/notification.js";
import { sendToMainChat } from "../components/main-chat.js";
import { setPeerActivityCallback } from "../components/transport/tool-registry.js";
import type { BootCtx, PhaseResult } from "./context.js";

const TAG = "agent_api";

export async function phaseAgentApi(ctx: BootCtx): Promise<PhaseResult> {
  const { config, memory, runtime, platforms, registry } = ctx;

  const agentConfig = loadAgentApiConfig(process.env as Record<string, string | undefined>);
  let agentApiServer: AgentApiServer | null = null;

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

      agentApiServer = new AgentApiServer({
        config: agentConfig,
        cliPath: config.transport.agentCliPath,
        workingDir: config.transport.workingDir,
        memory,
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
      logInfo("main", `🤖 Agent API enabled on 0.0.0.0:${agentConfig.port}`);    } else {
      logError("main", `Agent API failed to start: ${result.error}`);
    }

    // Start mDNS wake-up listener (#425)
    const { loadPeerConfig } = await import("../components/peer-config.js");
    const { startDnsWakeup } = await import("../components/dns-wakeup.js");
    const { startGossipListener } = await import("../components/peer-transport/gossip.js");
    const { callPeer } = await import("../components/peer-client.js");
    const peerConfig = loadPeerConfig();
    const udpPort = peerConfig.self.udpPort ?? 5353;

    // #971: Start gossip health listener
    if (Object.keys(peerConfig.peers).length > 0) {
      startGossipListener();
    }

    // #972: Start persistent outbound WS connections
    if (Object.keys(peerConfig.peers).length > 0) {
      import("../components/peer-transport/index.js").then(({ initPeerTransport }) => initPeerTransport()).catch(() => {});
    }

    if (Object.keys(peerConfig.peers).length > 0) {
      startDnsWakeup(udpPort, peerConfig, async (peerName) => {
        try {
          notifyPeer(`🤖 Agents: ${peerName} → UDP callback request received`);
          // Call peer to get their pending prompt
          const prompt = await callPeer(peerName, "callback: you requested a call-back via wake-up signal", peerConfig.maxHops, { skipWakeup: true });
          if (!prompt || prompt.trim() === "") return;
          // Process the prompt via local agent-api (self-call localhost HTTPS)
          const https = await import("node:https");
          const answer = await new Promise<string>((resolve, reject) => {
            const body = JSON.stringify({ model: "default", messages: [{ role: "user", content: prompt }] });
            const req = https.request({ hostname: "127.0.0.1", port: agentConfig.port, path: "/v1/chat/completions", method: "POST", rejectUnauthorized: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Authorization": `Bearer ${process.env["AGENT_API_TOKEN"] ?? ""}`  }, timeout: 55000 }, (res) => {
              let data = ""; res.on("data", c => data += c); res.on("end", () => { try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content ?? ""); } catch (err) { logAndSwallow(TAG, "JSON.parse agent-api response", err); resolve(""); } });
            });
            req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("self-call timeout")); });
            req.write(body); req.end();
          });
          // Deliver answer back to the requesting peer
          notifyPeer(`🤖 Agents: ${peerConfig.self.name} → ${peerName} messaged. [callback]`);
          await callPeer(peerName, `[CB-RESPONSE] ${answer}`, peerConfig.maxHops, { skipWakeup: true });
        } catch (err) {
          logError("dns-wakeup", `Callback to ${peerName} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }
  }
  return "ran";
}
