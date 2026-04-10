/**
 * agent-registry.ts — Centralized agent role configuration.
 * Single factory for all agent transports. Transport-agnostic.
 */

import { AcpTransport } from "./transport/acp-transport.js";

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
