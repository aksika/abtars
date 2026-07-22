/**
 * heartbeat-model-health.ts — Model health check task.
 * Probes each configured model on first tick. Reports failures to Telegram.
 */

import { getEnv } from "../components/env-schema.js";
import { logInfo, logWarn } from "../components/logger.js";
import type { BootCtx } from "./context.js";
import type { HeartbeatTask } from "../types/index.js";

export function createModelHealthTask(ctx: BootCtx): { task: HeartbeatTask; runNow: () => Promise<void> } {
  let done = false;

  const execute = async (): Promise<void> => {
    if (done) return;
    done = true;
    const { loadTransport, resolveAgent } = await import("../components/transport-config.js");
    const tc = loadTransport();
    if (!tc) return;

    const warnings: string[] = [];

    const prof = resolveAgent("main", tc);
    if (!prof) return;
    const profType = prof.provider.transport ?? "api";

    if (profType === "api") {
      const agents = ["main", "dreamy", "browsie", "cody"] as const;
      const modelToAgents = new Map<string, string[]>();
      const modelToResolved = new Map<string, { endpoint: string; apiKey: string }>();
      for (const a of agents) {
        const r = resolveAgent(a, tc);
        if (!r) continue;
        if (!modelToAgents.has(r.model)) {
          modelToAgents.set(r.model, []);
          modelToResolved.set(r.model, { endpoint: r.provider.endpoint ?? "http://localhost:11434/v1", apiKey: getEnv().getApiKey(r.provider.apiKeyEnv ?? "API_KEY") ?? "" });
        }
        modelToAgents.get(r.model)!.push(a);
      }
      for (const [model, agentNames] of modelToAgents) {
        const { endpoint, apiKey } = modelToResolved.get(model)!;
        try {
          const res = await fetch(`${endpoint}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) {
            warnings.push(`⚠️ ${model} — ${res.status} ${res.statusText} (affects ${agentNames.join(", ")})`);
            logWarn("model-health", `${model} failed: ${res.status} (${agentNames.join(", ")})`);
          } else {
            logInfo("model-health", `✓ ${agentNames[0]}=${model}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`⚠️ ${model} — ${msg} (affects ${agentNames.join(", ")})`);
          logWarn("model-health", `${model} unreachable: ${msg} (${agentNames.join(", ")})`);
        }
      }
    } else if (profType === "acp" || profType === "tmux") {
      const transport = ctx.transport;
      if (transport && "isConnected" in transport && typeof (transport as { isConnected?: () => boolean }).isConnected === "function") {
        const connected = (transport as { isConnected: () => boolean }).isConnected();
        if (connected) {
          logInfo("model-health", `✓ ${profType} transport connected`);
        } else {
          warnings.push(`⚠️ ${profType} transport not connected`);
          logWarn("model-health", `${profType} transport not connected`);
        }
      } else {
        logInfo("model-health", `✓ ${profType} transport (no isConnected check available)`);
      }
    }

    if (warnings.length > 0) {
      const { sendNotification } = await import("../components/notification.js");
      sendNotification(ctx, `Model health check:\n${warnings.join("\n")}\nSubagents will fall back to main model.`);
    }
  };

  return { task: { name: "model-health", execute }, runNow: execute };
}
