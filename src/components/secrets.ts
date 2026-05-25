/**
 * secrets.ts — Read/write secrets from ~/.abtars/secrets/ directory (#597, #598).
 * One file per secret. Supports plaintext (legacy) and encrypted (ENC: prefix).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { abtarsHome } from "../paths.js";

const SECRETS_DIR = join(abtarsHome(), "secrets");
const cache = new Map<string, string>();
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION = 0x01; // AES-256-GCM with HKDF purpose "abtars-secrets-files-v1"

// Ensure secrets dir exists on first import
if (!existsSync(SECRETS_DIR)) {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
}

// Lazy-init: derived key cached for process lifetime
let cachedKey: Buffer | null = null;

async function getSecretsKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const abmind = await import("abmind");
  cachedKey = abmind.deriveKey("abtars-secrets-files-v1");
  return cachedKey!;
}

function decryptSecret(blob: string, key: Buffer): string {
  const buf = Buffer.from(blob, "base64");
  const version = buf[0];
  if (version !== VERSION) throw new Error(`Unknown secret encryption version: ${version}`);
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(1 + IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, "utf-8") + decipher.final("utf-8");
}

function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([Buffer.from([VERSION]), iv, encrypted, tag]);
  return blob.toString("base64");
}

/** Read a secret from ~/.abtars/secrets/<name>. Cached per process. */
export function readSecret(name: string): string | undefined {
  if (cache.has(name)) return cache.get(name);
  try {
    const raw = readFileSync(join(SECRETS_DIR, name), "utf-8").trim();
    if (!raw) return undefined;
    if (raw.startsWith("ENC:")) {
      // Encrypted — need sync key access. Use cached key or fail.
      if (!cachedKey) throw new Error(`Encrypted secret ${name} but key not initialized. Call initSecretsKey() at boot.`);
      const value = decryptSecret(raw.slice(4), cachedKey);
      cache.set(name, value);
      return value;
    }
    cache.set(name, raw);
    return raw;
  } catch { return undefined; }
}

/** Initialize the secrets encryption key. Call once at boot (async). */
export async function initSecretsKey(): Promise<void> {
  if (cachedKey) return;
  try {
    cachedKey = await getSecretsKey();
  } catch { /* key not available — plaintext-only mode */ }
}

/** Write an encrypted secret to ~/.abtars/secrets/<name>. */
export async function writeSecret(name: string, value: string): Promise<void> {
  const key = await getSecretsKey();
  const encrypted = "ENC:" + encryptSecret(value, key);
  writeFileSync(join(SECRETS_DIR, name), encrypted, { mode: 0o600 });
  cache.set(name, value);
}

/** Clear cached secrets (for testing or reload). */
export function clearSecretCache(): void { cache.clear(); cachedKey = null; }
