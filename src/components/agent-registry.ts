/**
 * agent-registry.ts — Centralized agent role configuration.
 * Single factory for all agent transports. Transport-agnostic.
 */

import { AcpTransport } from "./transport/acp-transport.js";
import { readBridgeLockTransport } from "./transport/bridge-lock-transport.js";
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
    case "dreamy": return process.env["SLEEP_MODEL"] || undefined;
    case "browsie": return process.env["BROWSING_AGENT"] || undefined;
    case "coding": return process.env["CODING_MODEL"] || undefined;
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

const SUBAGENT_MODEL_ENV: Record<SubagentRole, string> = {
  sleep: "AGENT_SLEEP_MODEL",
  browse: "AGENT_BROWSE_MODEL",
  coding: "AGENT_CODING_MODEL",
  cron: "AGENT_MAIN_MODEL",
};

const SUBAGENT_CTX_ENV: Record<SubagentRole, string> = {
  sleep: "AGENT_SLEEP_CTX_WINDOW",
  browse: "AGENT_BROWSE_CTX_WINDOW",
  coding: "AGENT_CODING_CTX_WINDOW",
  cron: "AGENT_MAIN_CTX_WINDOW",
};

const SUBAGENT_ACP_ROLE: Record<SubagentRole, AgentRole> = {
  sleep: "dreamy",
  browse: "browsie",
  coding: "coding",
  cron: "cron",
};

/** Unified transport factory for all subagents. Reads bridge.lock for runtime truth. */
export async function createSubagentTransport(role: SubagentRole): Promise<{ transport: IKiroTransport; model: string }> {
  const mainTransport = readBridgeLockTransport();
  const { loadAndValidateConfig } = await import("./config.js");
  const config = await loadAndValidateConfig();

  const modelEnv = SUBAGENT_MODEL_ENV[role];
  const model = process.env[modelEnv] || config.models.mainModel || "auto";
  const defaultCtx = parseInt(process.env["API_DEFAULT_CONTEXT"] ?? "128000", 10);
  const maxContext = parseInt(process.env[SUBAGENT_CTX_ENV[role]] ?? "", 10) || defaultCtx;
  const maxOutput = parseInt(process.env["API_MAX_OUTPUT"] ?? "8192", 10);
  const maxTurns = parseInt(process.env["API_MAX_TURNS"] ?? "50", 10);

  // bridge.lock is runtime truth — if main agent is on Direct API, subagent follows
  if (mainTransport?.type === "api") {
    const { DirectApiTransport } = await import("./transport/direct-api-transport.js");
    const endpoint = mainTransport.endpoint ?? process.env["API_ENDPOINT"] ?? "http://localhost:11434/v1";
    const apiKey = process.env["API_KEY"];
    const fallbacks = mainTransport.model !== model
      ? [{ endpoint, apiKey, model: mainTransport.model, maxContext: defaultCtx }]
      : undefined;

    const transport = new DirectApiTransport({ endpoint, apiKey, model, maxContext, maxOutput, maxTurns, fallbacks });
    await transport.initialize();
    logInfo("subagent", `${role} transport: DirectAPI (model=${model}${fallbacks ? `, fallback=${mainTransport.model}` : ""})`);
    return { transport, model };
  }

  // ACP path
  const transport = createAgentTransport(SUBAGENT_ACP_ROLE[role], {
    cliPath: config.transport.agentCliPath,
    workingDir: config.transport.workingDir,
    agentCli: config.transport.agentCli,
    model: model !== "auto" ? model : undefined,
  });
  await transport.initialize();
  logInfo("subagent", `${role} transport: ACP (model=${model})`);
  return { transport, model };
}
