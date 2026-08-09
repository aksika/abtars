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
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
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
const secretDir = resolve(home, "secret");
const ENV_FILES = [
  resolve(home, "config", ".env"),
  resolve(home, "config", ".env.skills"),
];

// WEB_AUTH is intentionally stored in .env by the dashboard setup (#1354
// explicit exception): it is not an API/provider credential, must not be
// migrated, and keeps its SKIP_ENCRYPT handling below.
const MIGRATION_SKIP_KEYS = new Set(["WEB_AUTH"]);

import { compareSecret, writeSecretCompatible } from "../components/secrets.js";
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
  const inputs = ENV_FILES
    .filter(p => existsSync(p))
    .map(p => ({ path: p, content: readFileSync(p, "utf-8") }));
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

// Load secrets from ~/.abtars/secret/ — decrypt + auto-encrypt plaintext + load into process.env
import { loadKey, deriveKey, encrypt, decrypt, validateKey } from "../utils/crypto.js";

export function reloadSecrets(): void {
  if (!existsSync(secretDir)) return;

  const keyFile = resolve(home, "config", "abtars.key");
  const master = loadKey(keyFile);
  const purposeKey = master ? deriveKey(master) : null;

  if (purposeKey && !validateKey(keyFile, purposeKey)) {
    process.stderr.write(`[env] ⚠ abtars.key failed verification — secrets will not be decrypted (wrong passphrase?)\n`);
    return;
  }

  const SKIP_ENCRYPT = new Set(["WEB_AUTH"]);

  for (const file of readdirSync(secretDir)) {
    const fullPath = resolve(secretDir, file);
    if (!statSync(fullPath).isFile()) continue;
    const raw = readFileSync(fullPath, "utf-8").trim();
    if (!raw) continue;

    let value: string | null;
    if (raw.startsWith("ENC:")) {
      if (!purposeKey) continue;
      value = decrypt(raw, purposeKey);
      if (!value) {
        process.stderr.write(`[env] ⚠ Failed to decrypt secret/${file} — skipping (wrong key?)\n`);
        continue;
      }
    } else {
      value = raw;
      if (purposeKey && !SKIP_ENCRYPT.has(file)) {
        const encrypted = encrypt(value, purposeKey);
        try { writeFileSync(fullPath, encrypted, { mode: 0o600 }); } catch { /* leave plaintext */ }
      }
    }

    if (!file.includes(".")) {
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
