export interface AgentApiConfig {
  port: number;
  allowedIps: string[];
  agentCodename: string;
}

export function loadAgentApiConfig(env: Record<string, string | undefined>): AgentApiConfig | null {
  const rawIps = env["AGENT_API_ALLOWED_IPS"] ?? "";
  const allowedIps = rawIps.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowedIps.length === 0) {
    return null; // Missing config — caller skips agent-api gracefully
  }
  return {
    port: parseInt(env["AGENT_API_PORT"] || "3100", 10),
    allowedIps,
    agentCodename: (env["AGENT_CODENAME"] || "default").replace(/[^a-zA-Z0-9_]/g, ""),
  };
}
