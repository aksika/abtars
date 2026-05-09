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

export async function phaseAgentApi(ctx: BootCtx): Promise<PhaseResult> {
  const { config, memory, runtime, platforms, registry } = ctx;

  const agentConfig = loadAgentApiConfig(process.env as Record<string, string | undefined>);
  let agentApiServer: AgentApiServer | null = null;

  const notifyPeer = (msg: string): void => { sendNotification(ctx, msg); };
  setPeerActivityCallback(notifyPeer);

  registry.register("agent-api", {
    configured: Boolean(agentConfig.port),
    async create() {
      agentApiServer = new AgentApiServer({
        config: agentConfig,
        cliPath: config.transport.agentCliPath,
        workingDir: config.transport.workingDir,
        memory,
        runtime,
        onPeerActivity: notifyPeer,
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
    const { callPeer } = await import("../components/peer-client.js");
    const peerConfig = loadPeerConfig();
    const udpPort = peerConfig.self.udpPort ?? 5353;
    if (Object.keys(peerConfig.peers).length > 0) {
      startDnsWakeup(udpPort, peerConfig, async (peerName) => {
        try {
          notifyPeer(`🤖 Agents: ${peerName} → UDP callback request received`);
          // Call peer to get their pending prompt
          const prompt = await callPeer(peerName, "callback: you requested a call-back via wake-up signal", peerConfig.maxHops, { skipWakeup: true });
          if (!prompt || prompt.trim() === "") return;
          // Process the prompt via local agent-api (self-call localhost)
          const http = await import("node:http");
          const answer = await new Promise<string>((resolve, reject) => {
            const body = JSON.stringify({ model: "default", messages: [{ role: "user", content: prompt }] });
            const req = http.request({ hostname: "127.0.0.1", port: agentConfig.port, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Authorization": `Bearer ${process.env["AGENT_API_TOKEN"] ?? ""}`  }, timeout: 55000 }, (res) => {
              let data = ""; res.on("data", c => data += c); res.on("end", () => { try { resolve(JSON.parse(data)?.choices?.[0]?.message?.content ?? ""); } catch { resolve(""); } });
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
