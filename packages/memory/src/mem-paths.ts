/** Standalone paths for abmind. */

import { resolve } from "node:path";
import { homedir } from "node:os";

export function agentBridgeHome(): string {
  return process.env.AGENT_BRIDGE_HOME ?? resolve(homedir(), ".agentbridge");
}
