import { getEnv } from "./env-schema.js";
/**
 * agent-registry.ts — Centralized agent role configuration.
 * Single factory for all agent transports. Transport-agnostic.
 */

import { AcpTransport } from "./transport/acp-transport.js";
import { logInfo, logWarn } from "./logger.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";

export type AgentRole = "professor" | "dreamy" | "browsie" | "coding" | "task";

export interface AgentRoleConfig {
  agent: string | null;
  model: string | null;
  persona: string | null;
  autoReinit: boolean;
  tag: string;
  trust: number;
}

const AGENT_ROLES: Record<AgentRole, AgentRoleConfig> = {
  professor: { agent: "professor", model: null, persona: "persona/core/SOUL.md", autoReinit: true, tag: "acp-main", trust: 3 },
  dreamy: { agent: "dreamy", model: null, persona: "persona/prompts/sleep/00-identity.md", autoReinit: false, tag: "acp-sleep", trust: 2 },
  coding: { agent: "coding-agent", model: null, persona: null, autoReinit: true, tag: "acp-coding", trust: 2 },
  browsie: { agent: "browsie", model: null, persona: null, autoReinit: false, tag: "acp-browsie", trust: 1 },
  task: { agent: "professor", model: null, persona: null, autoReinit: false, tag: "acp-task", trust: 2 },
};

function resolveModel(role: AgentRole): string | undefined {
  switch (role) {
    case "dreamy": return getEnv().sleepModel;
    case "browsie": return getEnv().browsingAgent;
    case "coding": return getEnv().codingModel;
    default: return undefined;
  }
}

export interface TransportConfig {
  cliPath: string;
  workingDir: string;
  agentCli?: string;
  model?: string;
}

export function createAgentTransport(
  role: AgentRole,
  tc: TransportConfig,
  overrides?: Partial<AgentRoleConfig>,
): AcpTransport {
  const cfg = { ...AGENT_ROLES[role], ...overrides };
  const cliArgs = tc.agentCli === "gemini" ? ["--acp", "-y"] : undefined;
  const model = tc.model ?? resolveModel(role);

  return new AcpTransport(tc.cliPath, tc.workingDir, {
    agent: cfg.agent ?? undefined,
    model,
    autoReinit: cfg.autoReinit,
    tag: cfg.tag,
    cliArgs,
  });
}

export type SubagentRole = "sleep" | "browse" | "coding" | "task";

const SUBAGENT_TO_AGENT: Record<SubagentRole, string> = {
  sleep: "dreamy",
  browse: "browsie",
  coding: "coding",
  task: "professor",
};

const SUBAGENT_ACP_ROLE: Record<SubagentRole, AgentRole> = {
  sleep: "dreamy",
  browse: "browsie",
  coding: "coding",
  task: "task",
};

/** Unified transport factory for all subagents. Reads from transport.json + models.json. */
/** @internal Used only by SubagentRuntime. Do not call directly. */
export async function createSubagentTransport(role: SubagentRole, registry?: import("./transport/model-health-registry.js").ModelHealthRegistry, currentModel?: string): Promise<{ transport: IKiroTransport; model: string }> {
  const { resolveAgent, getEnvFallback, loadTransport } = await import("./transport-config.js");
  const tc = loadTransport();
  const agentName = SUBAGENT_TO_AGENT[role];
  const resolved = tc ? resolveAgent(agentName, tc) : null;

  // Fallback: use professor's config. If that also fails, use .env defaults.
  const profResolved = resolved ?? (tc ? resolveAgent("professor", tc) : null);
  const agent = profResolved ?? (() => {
    const fb = getEnvFallback();
    return { model: fb.model, provider: fb.provider, providerName: fb.providerName, contextWindow: fb.contextWindow, maxOutput: fb.maxOutput, fallbacks: [] };
  })();

  if (agent.provider.transport === "api") {
    const { DirectApiTransport } = await import("./transport/direct-api-transport.js");
    const { FallbackPolicy } = await import("./transport/fallback-policy.js");
    const apiKey = getEnv().getApiKey(agent.provider.apiKeyEnv ?? "API_KEY");

    // Use main transport's active model if available, else static config
    const startModel = currentModel ?? agent.model;

    // Build per-agent candidate list
    const candidates: Array<{ model: string; endpoint: string; apiKey?: string; maxContext: number }> = [
      { endpoint: agent.provider.endpoint ?? "http://localhost:11434/v1", apiKey, model: startModel, maxContext: agent.contextWindow },
    ];

    // Add static config model if different from startModel
    if (agent.model !== startModel && !candidates.some(c => c.model === agent.model)) {
      candidates.push({ endpoint: agent.provider.endpoint ?? "http://localhost:11434/v1", apiKey, model: agent.model, maxContext: agent.contextWindow });
    }

    // Add professor's model as fallback if different and transport-compatible
    const profAgent = tc ? resolveAgent("professor", tc) : null;
    const agentTransport = agent.provider.transport ?? "api";
    if (profAgent && profAgent.model !== startModel && !candidates.some(c => c.model === profAgent.model)) {
      const profTransport = profAgent.provider.transport ?? "api";
      if (profTransport === agentTransport && profAgent.provider.endpoint) {
        candidates.push({
          endpoint: profAgent.provider.endpoint,
          apiKey: profAgent.provider.apiKeyEnv ? getEnv().getApiKey(profAgent.provider.apiKeyEnv) : apiKey,
          model: profAgent.model,
          maxContext: profAgent.contextWindow,
        });
      }
    }

    // Inherit professor's full fallback chain (fb1→fb2→fb3)
    if (profAgent) {
      for (const fb of profAgent.fallbacks ?? []) {
        if (candidates.some(c => c.model === fb.model)) continue;
        const fbProvider = tc?.providers[fb.provider];
        const fbEndpoint = fbProvider?.endpoint ?? profAgent.provider.endpoint;
        if (!fbEndpoint) { logWarn("subagent", `Skipping fallback ${fb.model} — no endpoint configured`); continue; }
        const fbApiKey = fbProvider?.apiKeyEnv ? getEnv().getApiKey(fbProvider.apiKeyEnv) : apiKey;
        candidates.push({ endpoint: fbEndpoint, apiKey: fbApiKey, model: fb.model, maxContext: profAgent.contextWindow });
      }
      for (const chainModel of profAgent.provider.fallbackChain ?? []) {
        if (candidates.some(c => c.model === chainModel)) continue;
        if (!profAgent.provider.endpoint) { logWarn("subagent", `Skipping chain model ${chainModel} — no endpoint configured`); continue; }
        candidates.push({ endpoint: profAgent.provider.endpoint, apiKey, model: chainModel, maxContext: profAgent.contextWindow });
      }
    }

    // Append agent-level cross-provider fallbacks
    for (const fb of agent.fallbacks) {
      if (candidates.some(c => c.model === fb.model)) continue;
      const fbProvider = tc?.providers[fb.provider];
      const fbEndpoint = fbProvider?.endpoint ?? agent.provider.endpoint;
      if (!fbEndpoint) { logWarn("subagent", `Skipping fallback ${fb.model} — no endpoint configured`); continue; }
      const fbApiKey = fbProvider?.apiKeyEnv ? getEnv().getApiKey(fbProvider.apiKeyEnv) : apiKey;
      candidates.push({ endpoint: fbEndpoint, apiKey: fbApiKey, model: fb.model, maxContext: agent.contextWindow });
    }

    // Append fallbackChain entries as last-resort candidates
    const chain = agent.provider.fallbackChain ?? [];
    for (const chainModel of chain) {
      if (!candidates.some(c => c.model === chainModel)) {
        if (!agent.provider.endpoint) { logWarn("subagent", `Skipping chain model ${chainModel} — no endpoint configured`); continue; }
        candidates.push({
          endpoint: agent.provider.endpoint,
          apiKey, model: chainModel, maxContext: agent.contextWindow,
        });
      }
    }

    // Use shared registry if provided, otherwise create isolated one
    const { ModelHealthRegistry } = await import("./transport/model-health-registry.js");
    const policy = new FallbackPolicy(candidates, registry ?? new ModelHealthRegistry());

    const transport = new DirectApiTransport({
      endpoint: agent.provider.endpoint ?? "http://localhost:11434/v1",
      apiKey, model: startModel,
      maxContext: agent.contextWindow, maxOutput: agent.maxOutput,
      maxTurns: tc?.maxTurns ?? 50,
    }, policy);
    await transport.initialize();
    logInfo("subagent", `${role} transport: DirectAPI ${agent.providerName} (model=${startModel}, ${candidates.length} candidates, shared registry: ${!!registry})`);
    return { transport, model: agent.model };
  }

  // ACP path — try configured model, then fallbackChain on failure
  const { loadAndValidateConfig } = await import("./config.js");
  const config = await loadAndValidateConfig();
  const chain = agent.provider.fallbackChain ?? [];
  const modelsToTry = [agent.model, ...chain.filter(m => m !== agent.model)];

  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i]!;
    const transport = createAgentTransport(SUBAGENT_ACP_ROLE[role], {
      cliPath: agent.provider.cli ?? config.transport.agentCliPath,
      workingDir: config.transport.workingDir,
      agentCli: agent.provider.cli ?? "kiro-cli",
      model,
    });
    try {
      await transport.initialize();
      if (i > 0) logWarn("subagent", `${role}: configured model failed, fell back to ${model}`);
      logInfo("subagent", `${role} transport: ACP ${agent.providerName} (model=${model}${i > 0 ? ", fallback" : ""})`);
      return { transport, model };
    } catch (err) {
      if (i < modelsToTry.length - 1) {
        logWarn("subagent", `${role}: model ${model} init failed (${err instanceof Error ? err.message : String(err)}), trying ${modelsToTry[i + 1]}`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${role}: all models exhausted (tried ${modelsToTry.join(", ")})`);
}
