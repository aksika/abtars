import { resolve } from "node:path";
import { homedir } from "node:os";

/** Base directory for all AgentBridge runtime data. Override with AGENT_BRIDGE_HOME env var. */
export function agentBridgeHome(): string {
  return process.env.AGENT_BRIDGE_HOME ?? resolve(homedir(), ".agentbridge");
}
