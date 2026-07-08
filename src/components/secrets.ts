/**
 * secrets.ts — Read/write secrets from ~/.abtars/secret/ directory (#597, #598).
 * One file per secret. Supports plaintext (legacy) and encrypted (ENC: prefix).
 *
 * #1216: the AES-256-GCM crypto (encrypt/decrypt + constants) is delegated to
 * utils/crypto.ts. This module is the persistence + policy layer:
 *   - directory ensure, per-process value cache
 *   - plaintext vs ENC: routing
 *   - cached derived key (loadKey + deriveKey, both from utils/crypto.ts)
 *   - public API: readSecret / writeSecret / initSecretsKey / clearSecretCache
 *
 * Wire-format must remain byte-identical to the previous implementation so
 * existing ENC: files on KP/Molty decrypt unchanged. Verified in secrets.test.ts.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";
import { loadKey, deriveKey, encrypt, decrypt } from "../utils/crypto.js";

const SECRETS_DIR = join(abtarsHome(), "secret");
const cache = new Map<string, string>();

// Ensure secret dir exists on first import
if (!existsSync(SECRETS_DIR)) {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
}

// Lazy-init: derived key cached for process lifetime
let cachedKey: Buffer | null = null;

function getSecretsKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  const master = loadKey(join(abtarsHome(), "config", "abtars.key"));
  if (!master) return null;
  cachedKey = deriveKey(master, "abtars-secrets-v1");
  return cachedKey;
}

/** Read a secret from ~/.abtars/secret/<name>. Cached per process. */
export function readSecret(name: string): string | undefined {
  if (cache.has(name)) return cache.get(name);
  try {
    const raw = readFileSync(join(SECRETS_DIR, name), "utf-8").trim();
    if (!raw) return undefined;
    if (raw.startsWith("ENC:")) {
      const key = getSecretsKey();
      if (!key) return undefined;
      // crypto.decrypt expects the full "ENC:..." string and strips the prefix itself.
      const value = decrypt(raw, key);
      if (value === null) return undefined;
      cache.set(name, value);
      return value;
    }
    cache.set(name, raw);
    return raw;
  } catch { return undefined; }
}

/** Initialize the secrets encryption key. Call once at boot. */
export function initSecretsKey(): void {
  if (cachedKey) return;
  cachedKey = getSecretsKey();
}

/** Write an encrypted secret to ~/.abtars/secret/<name>. */
export function writeSecret(name: string, value: string): void {
  const key = getSecretsKey();
  if (!key) throw new Error("Cannot encrypt secret: abtars.key not found. Run abtars install.");
  // crypto.encrypt already prefixes "ENC:" — pass the value directly.
  writeFileSync(join(SECRETS_DIR, name), encrypt(value, key), { mode: 0o600 });
  cache.set(name, value);
}

/** Clear cached secret values (for testing or reload). Does not clear the encryption key. */
export function clearSecretCache(): void { cache.clear(); }
