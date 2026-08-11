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
 *
 * #1354: the pre-dotenv key set is snapshotted FIRST so credential cleanup
 * after migration can never delete operator/service-manager overrides.
 */

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { atomicWriteSync } from "../components/atomic-write.js";

const home = process.env["ABTARS_HOME"] ?? resolve(homedir(), ".abtars");
const preEnvKeys = new Set(Object.keys(process.env));
loadDotenv({ path: resolve(home, "config", ".env"), override: false });
loadDotenv({ path: resolve(home, "config", ".env.skills"), override: false });
loadDotenv({ path: resolve(process.cwd(), ".env"), override: false });

// #721/#752/#1354: Migrate credential-shaped assignments from .env files →
// secret/. The decision matrix (duplicates, conflicts, unsafe store, write
// failures) lives in env-secret-migration.ts; this module orchestrates:
//   1. commit secrets first (via the secrets policy layer)
//   2. atomically rewrite the source files
//   3. drop file-loaded process.env values for anything that could not
//      complete safely — while leaving pre-dotenv (operator) values alone
const ENV_FILES = [...new Set([
  resolve(home, "config", ".env"),
  resolve(home, "config", ".env.skills"),
  resolve(process.cwd(), ".env"),
])];

// WEB_AUTH is intentionally stored in .env by the dashboard setup (#1354
// explicit exception): it is not an API/provider credential, must not be
// migrated, and keeps its SKIP_ENCRYPT handling below.
const MIGRATION_SKIP_KEYS = new Set(["WEB_AUTH"]);

import { compareSecret, writeSecretCompatible, listSafeSecretFiles, loadSecretForBoot } from "../components/secrets.js";
import { runSecretMigration, isSecretEnvName } from "./env-secret-migration.js";
import type { SecretIO } from "./env-secret-migration.js";

const migrationIO: SecretIO = {
  compare: compareSecret,
  commit: writeSecretCompatible,
};

function runMigration(): string[] {
  // Returns the keys whose file-loaded values must NOT be usable this boot:
  // rejected keys (conflict/unsafe) and committed-but-not-cleaned keys.
  const suppressed: string[] = [];
  const inputs: Array<{ path: string; content: string }> = [];
  let inputReadFailed = false;
  for (const path of ENV_FILES) {
    if (!existsSync(path)) continue;
    try {
      inputs.push({ path, content: readFileSync(path, "utf-8") });
    } catch {
      // dotenv may already have loaded values before a concurrent permission
      // or filesystem failure. Suppress all file-loaded credential names below
      // rather than allowing an unreadable source to remain authoritative.
      inputReadFailed = true;
      process.stderr.write(`[env] Cannot inspect ${path.split("/").pop() ?? "environment file"} — credential values from files are disabled this boot\n`);
    }
  }
  if (inputReadFailed) {
    for (const key of Object.keys(process.env)) {
      if (isSecretEnvName(key) && !MIGRATION_SKIP_KEYS.has(key) && !preEnvKeys.has(key)) suppressed.push(key);
    }
  }
  if (inputs.length === 0) return suppressed;

  let result;
  try {
    result = runSecretMigration(inputs, migrationIO, { skipKeys: MIGRATION_SKIP_KEYS });
  } catch (err) {
    // A planning failure must not leave credentials exposed — the values
    // came from plaintext files we failed to process safely.
    process.stderr.write(`[env] Secret migration aborted: ${err instanceof Error ? err.message : String(err)}\n`);
    for (const f of inputs) {
      for (const line of f.content.split("\n")) {
        const eq = line.indexOf("=");
        const key = eq > 0 ? line.slice(0, eq).trim() : "";
        if (key && isSecretEnvName(key) && !MIGRATION_SKIP_KEYS.has(key)) suppressed.push(key);
      }
    }
    return suppressed;
  }

  // Apply rewrites AFTER all secrets are durably committed. A rewrite failure
  // means plaintext remains — the committed secret is kept for a later boot,
  // but the value must not be usable this boot (the key is re-suppressed
  // after reloadSecrets, which would otherwise load it from secret/).
  for (const f of result.files) {
    try {
      atomicWriteSync(f.path, f.content, 0o600);
    } catch (err) {
      process.stderr.write(`[env] Failed to clean plaintext credentials from ${f.path.split("/").pop()} — restart to retry\n`);
      const entry = result.removedByFile.find(r => r.path === f.path);
      if (entry) suppressed.push(...entry.keys);
    }
  }

  // Fail-closed: rejected keys must not remain usable from plaintext.
  suppressed.push(...result.envKeysToUnset);

  for (const d of result.decisions) {
    const from = d.sources.join(", ");
    switch (d.outcome) {
      case "migrated":
        process.stderr.write(`[env] Migrated ${d.key} from ${from} → secret/\n`);
        break;
      case "kept-existing":
        process.stderr.write(`[env] ${d.key} already stored in secret/ — removed plaintext copy from ${from}\n`);
        break;
      case "conflict-kept-existing":
        process.stderr.write(`[env] Existing secret ${d.key} kept (plaintext differed) — removed plaintext from ${from}. If the new value is intended, rotate it at ~/.abtars/secret/${d.key}\n`);
        break;
      case "rejected-conflict":
        process.stderr.write(`[env] Conflicting plaintext values for ${d.key} and no stored secret — provider disabled this boot. Rotate the key and store it at ~/.abtars/secret/${d.key}\n`);
        break;
      case "rejected-unsafe":
        process.stderr.write(`[env] Could not migrate ${d.key} safely (${d.reason ?? "store error"}) — provider disabled this boot. Store the key at ~/.abtars/secret/${d.key}\n`);
        break;
    }
  }
  return suppressed;
}

const suppressedKeys = runMigration();

export function reloadSecrets(): void {
  // The secrets policy layer performs lstat/ownership/mode checks and the
  // atomic plaintext→ENC upgrade. Never walk the directory with statSync:
  // that would follow a symlink planted in secret/.
  for (const file of listSafeSecretFiles()) {
    if (file.includes(".")) continue;
    const value = loadSecretForBoot(file, { skipEncrypt: file === "WEB_AUTH" });
    if (value !== undefined) {
      // #1354 R2.5: values that existed before dotenv loading (launchd /
      // shell / service-manager overrides) are never replaced by secrets.
      if (!preEnvKeys.has(file)) process.env[file] = value;
    }
  }
}

// Run on initial boot
reloadSecrets();

// #1354 R3.6: keys whose migration could not complete safely must not be
// usable this boot — even when reloadSecrets just loaded them from secret/.
// Pre-dotenv (operator) values are untouched.
for (const key of suppressedKeys) {
  if (!preEnvKeys.has(key)) delete process.env[key];
}

// Remove legacy <secret> lines from .env (they're redundant now)
try {
  const envPath = resolve(home, "config", ".env");
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    const cleaned = envContent.replace(/^[A-Z_]+=<secret>\s*$/gm, "").replace(/\n{3,}/g, "\n\n");
    if (cleaned !== envContent) writeFileSync(envPath, cleaned);
  }
} catch { /* non-critical */ }
