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
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";

const home = process.env["ABTARS_HOME"] ?? resolve(homedir(), ".abtars");
loadDotenv({ path: resolve(home, "config", ".env"), override: false });
loadDotenv({ path: resolve(home, "config", ".env.skills"), override: false });
loadDotenv({ path: resolve(process.cwd(), ".env"), override: false });

// #721/#752: Migrate misplaced API keys from any .env file → secret/
const SECRET_SUFFIXES = ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_API_ID"];
const secretDir = resolve(home, "secret");
const ENV_FILES = [
  resolve(home, "config", ".env"),
  resolve(home, "config", ".env.skills"),
];
for (const envPath of ENV_FILES) {
  if (!existsSync(envPath) || !existsSync(secretDir)) continue;
  const content = readFileSync(envPath, "utf-8");
  const lines = content.split("\n");
  const migrated: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1).trim();
    if (!val || !SECRET_SUFFIXES.some(s => key.endsWith(s))) continue;
    const secretPath = resolve(secretDir, key);
    if (existsSync(secretPath)) continue;
    writeFileSync(secretPath, val, { mode: 0o600 });
    migrated.push(key);
  }
  if (migrated.length > 0) {
    const cleaned = lines.filter(l => {
      const t = l.trim();
      if (!t || t.startsWith("#")) return true;
      const k = t.slice(0, t.indexOf("="));
      return !migrated.includes(k);
    }).join("\n");
    writeFileSync(envPath, cleaned, { mode: 0o600 });
    const name = envPath.split("/").pop();
    for (const k of migrated) process.stderr.write(`[env] Migrated ${k} from ${name} → secret/\n`);
  }
}

// Load secrets from ~/.abtars/secret/ — decrypt + auto-encrypt plaintext + load into process.env

export function reloadSecrets(): void {
  if (!existsSync(secretDir)) return;

  const { loadKey, deriveKey, encrypt, decrypt } = require("../utils/crypto.js") as typeof import("../utils/crypto.js");
  const keyFile = resolve(secretDir, "abtars.key");
  const master = loadKey(keyFile);
  const purposeKey = master ? deriveKey(master) : null;

  const SKIP_ENCRYPT = new Set(["WEB_AUTH_TOKEN", "abtars.key"]);

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
      process.env[file] = value;
    }
  }
}

// Run on initial boot
reloadSecrets();

// Remove legacy <secret> lines from .env (they're redundant now)
try {
  const envPath = resolve(home, "config", ".env");
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    const cleaned = envContent.replace(/^[A-Z_]+=<secret>\s*$/gm, "").replace(/\n{3,}/g, "\n\n");
    if (cleaned !== envContent) writeFileSync(envPath, cleaned);
  }
} catch { /* non-critical */ }
