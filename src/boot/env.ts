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

// #721: Migrate misplaced API keys from .env.skills → secret/
// Only acts on uncommented lines with actual values (dotenv skips # comments)
const SECRET_SUFFIXES = ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD"];
const envSkillsPath = resolve(home, "config", ".env.skills");
const secretDir = resolve(home, "secret");
if (existsSync(envSkillsPath) && existsSync(secretDir)) {
  const skillsContent = readFileSync(envSkillsPath, "utf-8");
  const lines = skillsContent.split("\n");
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
    // Remove migrated keys from .env.skills
    const cleaned = lines.filter(l => {
      const t = l.trim();
      if (!t || t.startsWith("#")) return true;
      const k = t.slice(0, t.indexOf("="));
      return !migrated.includes(k);
    }).join("\n");
    writeFileSync(envSkillsPath, cleaned, { mode: 0o600 });
    for (const k of migrated) process.stderr.write(`[env] Migrated ${k} from .env.skills → secret/\n`);
  }
}

// Load secrets from ~/.abtars/secret/ — decrypt + auto-encrypt plaintext + load into process.env
import { createDecipheriv, createCipheriv, randomBytes, hkdfSync } from "node:crypto";

if (existsSync(secretDir)) {
  let purposeKey: Buffer | null = null;

  function getPurposeKey(): Buffer | null {
    if (purposeKey) return purposeKey;
    try {
      // Read master key directly from file (no abmind import needed in bundle)
      const abmindHome = process.env["ABMIND_HOME"] ?? resolve(homedir(), ".abmind");
      const keyFile = resolve(abmindHome, "secret", "abmind.key");
      if (!existsSync(keyFile)) return null;
      const hex = readFileSync(keyFile, "utf-8").trim();
      if (hex.length !== 64) return null;
      const master = Buffer.from(hex, "hex");
      purposeKey = Buffer.from(hkdfSync("sha256", master, "", "abtars-secrets-files-v1", 32));
      return purposeKey;
    } catch { return null; }
  }

  function decryptFile(raw: string): string | null {
    const key = getPurposeKey();
    if (!key) return null;
    const buf = Buffer.from(raw.slice(4), "base64");
    const iv = buf.subarray(1, 13);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(13, buf.length - 16);
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return d.update(ct, undefined, "utf-8") + d.final("utf-8");
  }

  function encryptFile(plaintext: string): string | null {
    const key = getPurposeKey();
    if (!key) return null;
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([c.update(plaintext, "utf-8"), c.final()]);
    return "ENC:" + Buffer.concat([Buffer.from([0x01]), iv, enc, c.getAuthTag()]).toString("base64");
  }

  // Tokens that should stay readable (not encrypted) — localhost convenience tokens
  const SKIP_ENCRYPT = new Set(["WEB_AUTH_TOKEN"]);

  for (const file of readdirSync(secretDir)) {
    const fullPath = resolve(secretDir, file);
    if (!statSync(fullPath).isFile()) continue;
    const raw = readFileSync(fullPath, "utf-8").trim();
    if (!raw) continue;

    let value: string | null;
    if (raw.startsWith("ENC:")) {
      value = decryptFile(raw);
      if (!value) continue;
    } else {
      value = raw;
      // Auto-encrypt plaintext in place (skip tokens that need to stay readable)
      if (!SKIP_ENCRYPT.has(file)) {
        const encrypted = encryptFile(value);
        if (encrypted) { try { writeFileSync(fullPath, encrypted, { mode: 0o600 }); } catch { /* leave plaintext */ } }
      }
    }

    // No extension → env var. Has extension → tool access only.
    if (!file.includes(".")) {
      process.env[file] = value;
    }
  }
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
