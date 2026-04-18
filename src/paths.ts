import { resolve, join } from "node:path";
import { homedir } from "node:os";

/** Base directory for all AgentBridge runtime data. Override with AGENT_BRIDGE_HOME env var. */
export function agentBridgeHome(): string {
  return process.env.AGENT_BRIDGE_HOME ?? resolve(homedir(), ".agentbridge");
}

/**
 * Canonical path for user-facing reports, grouped by category.
 * Example: reportsDir("tasks") → ~/.agentbridge/reports/tasks/
 *
 * Callers are responsible for mkdirSync(dir, { recursive: true }).
 * All agentbridge-produced reports should live under this tree so they're
 * discoverable by the send-report skill and the future consolidation work.
 */
export function reportsDir(category: string): string {
  return join(agentBridgeHome(), "reports", category);
}
