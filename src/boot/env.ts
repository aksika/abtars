/**
 * Env bootstrap — side-effect-only. Import FIRST in main.ts.
 *
 * Loads dotenv during this module's evaluation so subsequent static imports
 * (which ES hoists above any body statements in main.ts) see .env values at
 * module-top read time. Without this, module-level `const X = process.env["X"]
 * ?? default` reads freeze the default before dotenv runs.
 *
 * Precedence (highest → lowest):
 *   process.env                           (ops override — launchd/systemd/shell export)
 *   $AGENT_BRIDGE_HOME/.env               (legacy root — real values on existing installs)
 *   $AGENT_BRIDGE_HOME/config/.env        (new primary — what `agentbridge onboard` writes)
 *   $AGENT_BRIDGE_HOME/config/.env.skills (skill-specific)
 *   ./.env                                (cwd)
 *
 * Root .env wins over config/.env because existing installs carry real operator
 * secrets in root .env, while config/.env starts as a template with empty values
 * (TELEGRAM_BOT_TOKEN= etc.). Empty-but-present would mask the real one under
 * `override: false`, so root goes first.
 *
 * `override: false` preserves process.env precedence — operator-set vars
 * (launchd plist, shell export) win over .env values.
 */

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { homedir } from "node:os";

const home = process.env["AGENT_BRIDGE_HOME"] ?? resolve(homedir(), ".agentbridge");
loadDotenv({ path: resolve(home, ".env"), override: false });
loadDotenv({ path: resolve(home, "config", ".env"), override: false });
loadDotenv({ path: resolve(home, "config", ".env.skills"), override: false });
loadDotenv({ path: resolve(process.cwd(), ".env"), override: false });
