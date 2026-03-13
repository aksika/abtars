export interface AgentApiConfig {
  port: number;
  allowedIps: string[];
  token: string;
  sessionKey: string;
  chatId: number;
}

export function loadAgentApiConfig(env: Record<string, string | undefined>): AgentApiConfig {
  const rawIps = env["AGENT_API_ALLOWED_IPS"] ?? "";
  const allowedIps = rawIps.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowedIps.length === 0) {
    throw new Error("AGENT_API_ALLOWED_IPS is required when --agent is enabled (comma-separated IPs)");
  }
  return {
    port: parseInt(env["AGENT_API_PORT"] || "3001", 10),
    allowedIps,
    token: env["AGENT_API_TOKEN"] ?? "",
    sessionKey: env["AGENT_SESSION_KEY"] || "agent:molty",
    chatId: parseInt(env["AGENT_CHAT_ID"] || "1", 10),
  };
}
