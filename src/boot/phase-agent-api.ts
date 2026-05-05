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
import type { BootCtx } from "./context.js";

export async function phaseAgentApi(ctx: BootCtx): Promise<void> {
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
  }
}
