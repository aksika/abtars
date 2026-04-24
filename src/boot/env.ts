/**
 * Env bootstrap — side-effect-only. Import FIRST in main.ts.
 *
 * Loads dotenv during this module's evaluation so subsequent static imports
 * (which ES hoists above any body statements in main.ts) see .env values at
 * module-top read time. Without this, module-level `const X = process.env["X"]
 * ?? default` reads freeze the default before dotenv runs.
 *
 * Precedence (highest → lowest):
 *   process.env
 *   $AGENT_BRIDGE_HOME/config/.env        (primary — what `agentbridge onboard` writes)
 *   $AGENT_BRIDGE_HOME/.env               (legacy root .env — kept for backward compat)
 *   $AGENT_BRIDGE_HOME/config/.env.skills (skill-specific overrides)
 *   ./.env                                (cwd)
 *
 * `override: false` preserves process.env precedence — operator-set vars
 * (launchd plist, shell export) win over .env values.
 */

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { homedir } from "node:os";

const home = process.env["AGENT_BRIDGE_HOME"] ?? resolve(homedir(), ".agentbridge");
loadDotenv({ path: resolve(home, "config", ".env"), override: false });
loadDotenv({ path: resolve(home, ".env"), override: false });
loadDotenv({ path: resolve(home, "config", ".env.skills"), override: false });
loadDotenv({ path: resolve(process.cwd(), ".env"), override: false });
