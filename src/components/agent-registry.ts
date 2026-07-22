import type { CandidateSpec, ModelCandidate } from "./transport/model-candidates.js";
import { buildCandidates } from "./transport/model-candidates.js";
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
  coding: "cody",
  task: "main",
};

const SUBAGENT_ACP_ROLE: Record<SubagentRole, AgentRole> = {
  sleep: "dreamy",
  browse: "browsie",
  coding: "coding",
  task: "task",
};

/** Unified transport factory for all subagents. Reads from transport.json + models.json. */
/** @internal Used only by SubagentRuntime. Do not call directly. */
export async function createSubagentTransport(role: SubagentRole, registry?: import("./transport/model-health-registry.js").ModelHealthRegistry, lastSuccessfulMain?: CandidateSpec | null): Promise<{ transport: IKiroTransport; model: string }> {
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
    const { PiCoreTransport } = await import("./transport/pi-core-transport.js");
    const apiKey = getEnv().getApiKey(agent.provider.apiKeyEnv ?? "API_KEY");

    const primaryEndpoint = agent.provider.endpoint ?? "http://localhost:11434/v1";

    const configured: ModelCandidate = {
      model: agent.model, provider: agent.providerName, endpoint: primaryEndpoint,
      apiKey, maxContext: agent.contextWindow, source: "primary",
    };

    const mainAgent = tc ? resolveAgent("main", tc) : null;
    const configuredMainSpec: CandidateSpec | null = mainAgent
      ? { model: mainAgent.model, provider: mainAgent.providerName, endpoint: mainAgent.provider.endpoint ?? primaryEndpoint, maxContext: mainAgent.contextWindow }
      : null;
    const inheritedSpec = lastSuccessfulMain ?? configuredMainSpec;
    let inheritedCandidate: ModelCandidate | null = null;
    if (inheritedSpec) {
      const inheritedProvider = tc?.providers[inheritedSpec.provider];
      inheritedCandidate = {
        model: inheritedSpec.model, provider: inheritedSpec.provider, endpoint: inheritedSpec.endpoint,
        apiKey: inheritedProvider?.apiKeyEnv ? getEnv().getApiKey(inheritedProvider.apiKeyEnv) : apiKey,
        maxContext: inheritedSpec.maxContext, source: "inherited_chain",
      };
    }

    const fallbackCandidates: ModelCandidate[] = (tc?.fallbacks ?? []).map(fb => {
      const fbProvider = tc!.providers[fb.provider];
      return {
        model: fb.model, provider: fb.provider, endpoint: fbProvider?.endpoint ?? primaryEndpoint,
        apiKey: fbProvider?.apiKeyEnv ? getEnv().getApiKey(fbProvider.apiKeyEnv) : apiKey,
        maxContext: mainAgent?.contextWindow ?? agent.contextWindow, source: "agent_fallback",
      };
    });

    const candidates = buildCandidates({ role: "specialist", configured, lastSuccessfulMain: inheritedCandidate, fallbacks: fallbackCandidates });

    const { ModelHealthRegistry } = await import("./transport/model-health-registry.js");

    const transport = new PiCoreTransport({
      role: "specialist",
      systemPrompt: agent.provider.endpoint ?? "",
      candidates,
      healthRegistry: registry ?? new ModelHealthRegistry(),
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    });
    await transport.initialize();
    logInfo("subagent", `${role} transport: PiCore ${agent.providerName} (model=${agent.model}, ${candidates.length} candidates)`);
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
