/**
 * AgentBridge — entry point.
 * Parses CLI args, starts the bridge, handles fatal errors.
 *
 * Env loading: done here at main.ts top BEFORE any module import that reads
 * process.env. `override: false` preserves process.env precedence (operator-set
 * vars win over .env). Inherited from openclaw's pattern — Node owns its own
 * env, shell scripts just exec node, no source chain to break.
 *
 * Precedence (highest → lowest):
 *   process.env  >  $AGENT_BRIDGE_HOME/.env  >  $AGENT_BRIDGE_HOME/config/.env.skills  >  ./.env
 */

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { homedir } from "node:os";

const home = process.env["AGENT_BRIDGE_HOME"] ?? resolve(homedir(), ".agentbridge");
loadDotenv({ path: resolve(home, ".env"), override: false });
loadDotenv({ path: resolve(home, "config", ".env.skills"), override: false });
loadDotenv({ path: resolve(process.cwd(), ".env"), override: false });

import { startBridge } from "./bridge-app.js";

process.on("uncaughtException", (err) => {
  console.error(`[FATAL] Uncaught exception: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[FATAL] Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : reason}`);
  process.exit(1);
});

startBridge().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
