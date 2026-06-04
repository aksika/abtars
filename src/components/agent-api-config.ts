export interface AgentApiConfig {
  port: number;
  agentCodename: string;
}

export function loadAgentApiConfig(env: Record<string, string | undefined>): AgentApiConfig {
  return {
    port: parseInt(env["AGENT_API_PORT"] || "3100", 10),
    agentCodename: (env["AGENT_CODENAME"] || "default").replace(/[^a-zA-Z0-9_]/g, ""),
  };
}
