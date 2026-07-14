import type { CandidateSource } from "./transport/model-candidates.js";
import { getEnv } from "./env-schema.js";
/**
 * agent-registry.ts — Centralized agent role configuration.
 * Single factory for all agent transports. Transport-agnostic.
 */

import { AcpTransport } from "./transport/acp-transport.js";
import { logInfo, logWarn } from "./logger.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";

export type AgentRole = "main" | "professor" | "dreamy" | "browsie" | "coding" | "cody" | "task";

export interface AgentRoleConfig {
  agent: string | null;
  model: string | null;
  autoReinit: boolean;
  tag: string;
  trust: number;
}

const AGENT_ROLES: Record<string, AgentRoleConfig> = {
  main: { agent: "professor", model: null, autoReinit: true, tag: "acp-main", trust: 3 },
  professor: { agent: "professor", model: null, autoReinit: true, tag: "acp-main", trust: 3 },
  dreamy: { agent: "dreamy", model: null, autoReinit: false, tag: "acp-sleep", trust: 2 },
  coding: { agent: "coding-agent", model: null, autoReinit: true, tag: "acp-coding", trust: 2 },
  cody: { agent: "coding-agent", model: null, autoReinit: true, tag: "acp-coding", trust: 2 },
  browsie: { agent: "browsie", model: null, autoReinit: false, tag: "acp-browsie", trust: 1 },
  task: { agent: "professor", model: null, autoReinit: false, tag: "acp-task", trust: 2 },
};

function resolveModel(role: string): string | undefined {
  switch (role) {
    case "dreamy": return getEnv().sleepModel;
    case "browsie": return getEnv().browsingAgent;
    case "coding": case "cody": return getEnv().codingModel;
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

  // Fallback: use main's config. If that also fails, use .env defaults.
  const mainResolved = resolved ?? (tc ? resolveAgent("main", tc) : null);
  const agent = mainResolved ?? (() => {
    const fb = getEnvFallback();
    return { model: fb.model, provider: fb.provider, providerName: fb.providerName, contextWindow: fb.contextWindow, maxOutput: fb.maxOutput, fallbacks: [] };
  })();

  if (agent.provider.transport === "api") {
    const { DirectApiTransport } = await import("./transport/direct-api-transport.js");
    const { FallbackPolicy } = await import("./transport/fallback-policy.js");
    const apiKey = getEnv().getApiKey(agent.provider.apiKeyEnv ?? "API_KEY");

    // Use main transport's active model if available, else static config
    const startModel = currentModel ?? agent.model;

    /**
     * Resolve the correct endpoint + apiKey for a given model by scanning the full
     * transport.json candidate space: all agents' primary + fallback entries.
     * This is needed when startModel was inherited from Main and may belong to a
     * different provider than agent.provider (e.g. Main fell back to Ollama while
     * the task agent's primary provider is OpenRouter).
     */
    function resolveModelEndpoint(model: string): { endpoint: string; apiKey: string | undefined } | null {
      if (!tc) return null;
      for (const [, agentEntry] of Object.entries(tc.agents)) {
        const primaryProvider = tc.providers[agentEntry.provider];
        if (primaryProvider?.transport === "api" && agentEntry.model === model && primaryProvider.endpoint) {
          return {
            endpoint: primaryProvider.endpoint,
            apiKey: primaryProvider.apiKeyEnv ? getEnv().getApiKey(primaryProvider.apiKeyEnv) : undefined,
          };
        }
      }
      // Check top-level fallbacks
      for (const fb of tc.fallbacks ?? []) {
        if (fb.model !== model) continue;
        const fbProvider = tc.providers[fb.provider];
        if (fbProvider?.transport === "api" && fbProvider.endpoint) {
          return {
            endpoint: fbProvider.endpoint,
            apiKey: fbProvider.apiKeyEnv ? getEnv().getApiKey(fbProvider.apiKeyEnv) : undefined,
          };
        }
      }
      return null;
    }

    // Resolve the correct endpoint for startModel. When startModel was inherited
    // from Main and belongs to a different provider, this finds the right endpoint
    // instead of blindly using agent.provider.endpoint (#1307).
    const startModelResolved = startModel !== agent.model ? resolveModelEndpoint(startModel) : null;
    const startEndpoint = startModelResolved?.endpoint ?? agent.provider.endpoint ?? "http://localhost:11434/v1";
    const startApiKey = startModelResolved?.apiKey ?? apiKey;

    // Build per-agent candidate list
    // Dedup key is model+endpoint pair — same model on different providers is a distinct candidate.
    const candidateKey = (model: string, endpoint: string): string => `${model}@${endpoint}`;
    const seenCandidates = new Set<string>();
    const candidates: Array<{ model: string; endpoint: string; apiKey?: string; maxContext: number; source: CandidateSource }> = [];

    const addCandidate = (model: string, endpoint: string, candidateApiKey: string | undefined, maxContext: number, source: CandidateSource): void => {
      const key = candidateKey(model, endpoint);
      if (seenCandidates.has(key)) return;
      seenCandidates.add(key);
      candidates.push({ model, endpoint, apiKey: candidateApiKey, maxContext, source });
    };

    // #1386: Track candidate source for diagnostics
    addCandidate(startModel, startEndpoint, startApiKey, agent.contextWindow, startModel !== agent.model ? "inherited_chain" : "primary");

    // Add static config model if different from startModel
    if (agent.model !== startModel) {
      addCandidate(agent.model, agent.provider.endpoint ?? "http://localhost:11434/v1", apiKey, agent.contextWindow, "primary");
    }

    // Add main's model as fallback if different and transport-compatible
    const mainAgent = tc ? resolveAgent("main", tc) : null;
    const agentTransport = agent.provider.transport ?? "api";
    if (mainAgent && mainAgent.model !== startModel) {
      const mainTransport = mainAgent.provider.transport ?? "api";
      if (mainTransport === agentTransport && mainAgent.provider.endpoint) {
        addCandidate(
          mainAgent.model,
          mainAgent.provider.endpoint,
          mainAgent.provider.apiKeyEnv ? getEnv().getApiKey(mainAgent.provider.apiKeyEnv) : apiKey,
          mainAgent.contextWindow,
          "inherited_chain",
        );
      }
    }

    // Inherit main's full fallback chain (top-level fallbacks)
    if (mainAgent) {
      for (const fb of tc?.fallbacks ?? []) {
        const fbProvider = tc?.providers[fb.provider];
        const fbEndpoint = fbProvider?.endpoint ?? mainAgent.provider.endpoint;
        if (!fbEndpoint) { logWarn("subagent", `Skipping fallback ${fb.model} — no endpoint configured`); continue; }
        const fbApiKey = fbProvider?.apiKeyEnv ? getEnv().getApiKey(fbProvider.apiKeyEnv) : apiKey;
        addCandidate(fb.model, fbEndpoint, fbApiKey, mainAgent.contextWindow, "inherited_chain");
      }
    }

    // Append top-level fallbacks as last-resort candidates (already in inherited_chain above, but keep for clarity)
    // Agent's resolved fallbacks from resolveAgent are already included in agent.fallbacks

    // Use shared registry if provided, otherwise create isolated one
    const { ModelHealthRegistry } = await import("./transport/model-health-registry.js");
    const policy = new FallbackPolicy(candidates, registry ?? new ModelHealthRegistry());

    const transport = new DirectApiTransport({
      provider: agent.providerName,
      endpoint: startEndpoint,
      apiKey: startApiKey, model: startModel,
      maxContext: agent.contextWindow, maxOutput: agent.maxOutput,
      maxTurns: tc?.maxTurns ?? 50,
      maxToolRounds: tc?.maxToolRounds ?? 25,
      maxFallbackToolRounds: tc?.maxFallbackToolRounds ?? 5,
      useProviderLib: agent.provider.useProviderLib,
    }, policy);
    await transport.initialize();
    logInfo("subagent", `${role} transport: DirectAPI ${agent.providerName} (model=${startModel}, ${candidates.length} candidates, shared registry: ${!!registry})`);
    return { transport, model: agent.model };
  }

  // ACP path — try configured model, then top-level fallbacks on failure
  const { loadAndValidateConfig } = await import("./config.js");
  const config = await loadAndValidateConfig();
  const fallbackModels = (tc?.fallbacks ?? []).map(f => f.model).filter(m => m !== agent.model);
  const modelsToTry = [agent.model, ...fallbackModels];

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
