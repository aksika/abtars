import { getEnv } from "./env-schema.js";
/**
 * agent-registry.ts — Centralized agent role configuration.
 * Single factory for all agent transports. Transport-agnostic.
 */

import { AcpTransport } from "./transport/acp-transport.js";
import { logInfo } from "./logger.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";

export type AgentRole = "professor" | "dreamy" | "browsie" | "coding" | "cron";

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
  dreamy: { agent: null, model: null, persona: "persona/prompts/sleep/00-identity.md", autoReinit: false, tag: "acp-sleep", trust: 2 },
  coding: { agent: "coding-agent", model: null, persona: null, autoReinit: true, tag: "acp-coding", trust: 2 },
  browsie: { agent: null, model: null, persona: null, autoReinit: false, tag: "acp-browsie", trust: 1 },
  cron: { agent: "professor", model: null, persona: null, autoReinit: false, tag: "acp-cron", trust: 2 },
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

export function getAgentConfig(role: AgentRole): AgentRoleConfig {
  return AGENT_ROLES[role];
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
    skipAgent: cfg.agent === null,
    model,
    autoReinit: cfg.autoReinit,
    tag: cfg.tag,
    cliArgs,
  });
}

export type SubagentRole = "sleep" | "browse" | "coding" | "cron";

const SUBAGENT_TO_AGENT: Record<SubagentRole, string> = {
  sleep: "dreamy",
  browse: "browsie",
  coding: "coding",
  cron: "professor",
};

const SUBAGENT_ACP_ROLE: Record<SubagentRole, AgentRole> = {
  sleep: "dreamy",
  browse: "browsie",
  coding: "coding",
  cron: "cron",
};

/** Unified transport factory for all subagents. Reads from transport.json + models.json. */
/** @internal Used only by SubagentRuntime. Do not call directly. */
export async function createSubagentTransport(role: SubagentRole): Promise<{ transport: IKiroTransport; model: string }> {
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
    const apiKey = getEnv().getApiKey(agent.provider.apiKeyEnv ?? "API_KEY");

    // Subagent fallback: always professor's model+provider
    const profAgent = tc ? resolveAgent("professor", tc) : null;
    const fallbacks = profAgent && profAgent.model !== agent.model
      ? [{ endpoint: profAgent.provider.endpoint ?? agent.provider.endpoint!, apiKey: profAgent.provider.apiKeyEnv ? process.env[profAgent.provider.apiKeyEnv] : apiKey, model: profAgent.model, maxContext: profAgent.contextWindow }]
      : undefined;

    const transport = new DirectApiTransport({
      endpoint: agent.provider.endpoint ?? "http://localhost:11434/v1",
      apiKey, model: agent.model,
      maxContext: agent.contextWindow, maxOutput: agent.maxOutput,
      maxTurns: tc?.maxTurns ?? 50, fallbacks,
    });
    await transport.initialize();
    logInfo("subagent", `${role} transport: DirectAPI ${agent.providerName} (model=${agent.model}${fallbacks ? `, fallback=${profAgent!.model}` : ""})`);
    return { transport, model: agent.model };
  }

  // ACP path
  const { loadAndValidateConfig } = await import("./config.js");
  const config = await loadAndValidateConfig();
  const transport = createAgentTransport(SUBAGENT_ACP_ROLE[role], {
    cliPath: agent.provider.cli ?? config.transport.agentCliPath,
    workingDir: config.transport.workingDir,
    agentCli: agent.provider.cli ?? config.transport.agentCli,
    model: agent.model,
  });
  await transport.initialize();
  logInfo("subagent", `${role} transport: ACP ${agent.providerName} (model=${agent.model})`);
  return { transport, model: agent.model };
}
