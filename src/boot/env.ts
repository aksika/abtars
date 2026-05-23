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
 *   $ABTARS_HOME/config/.env        (primary — what `abtars onboard` writes)
 *   $ABTARS_HOME/config/.env.skills (skill-specific)
 *   ./.env                                (cwd)
 *
 * `override: false` preserves process.env precedence — operator-set vars
 * (launchd plist, shell export) win over .env values.
 */

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";

const home = process.env["ABTARS_HOME"] ?? resolve(homedir(), ".abtars");
loadDotenv({ path: resolve(home, "config", ".env"), override: false });
loadDotenv({ path: resolve(home, "config", ".env.skills"), override: false });
loadDotenv({ path: resolve(process.cwd(), ".env"), override: false });

// Resolve <secret> placeholders: any env var with value "<secret>" is read from ~/.abtars/secret/<VAR_NAME>
const secretDir = resolve(home, "secret");
for (const [key, val] of Object.entries(process.env)) {
  if (val?.trim() === "<secret>") {
    const file = resolve(secretDir, key);
    if (existsSync(file)) {
      const secret = readFileSync(file, "utf-8").trim();
      if (secret) { process.env[key] = secret; }
      else { console.error(`[BOOT ERROR] ${key}=<secret> but ${file} is empty`); }
    } else {
      console.error(`[BOOT ERROR] ${key}=<secret> but ${file} does not exist`);
    }
  }
}
