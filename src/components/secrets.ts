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
 * #1354: credential-store policy invariants. The store is the authoritative
 * persistent location for API keys and equivalent provider credentials:
 *   - secret names are validated (no traversal, no path separators)
 *   - symlinks, wrong ownership, and unsafe modes fail closed — never followed
 *   - owned regular files/dirs are narrowed to 0600 / 0700 automatically
 *   - writes are atomic (tmp → fsync → rename) with owner-only modes
 *   - errors never carry credential values
 *
 * Wire-format must remain byte-identical to the previous implementation so
 * existing ENC: files on KP/Molty decrypt unchanged. Verified in secrets.test.ts.
 */
import { readFileSync, mkdirSync, existsSync, lstatSync, chmodSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { abtarsHome } from "../paths.js";
import { loadKey, deriveKey, encrypt, decrypt } from "../utils/crypto.js";
import { atomicWriteSync } from "./atomic-write.js";

export const SECRETS_DIR = resolve(abtarsHome(), "secret");
const cache = new Map<string, string>();

/** Env-var shaped secret name: OPENAI_API_KEY, HA_TOKEN, ... (#1354 R1). */
export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Suffixes that mark an assignment as a credential (#1354 R1.2). */
export const SECRET_ENV_SUFFIXES = ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_API_ID"] as const;

/** True when the name is a valid environment-variable secret name. */
export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/** True when an env-var name is credential-shaped per #1354 R1.2. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_RE.test(name) && SECRET_ENV_SUFFIXES.some(s => name.endsWith(s));
}

/**
 * Resolve a secret file path beneath the secret root, refusing traversal.
 * Throws (with a value-free message) on any name that could escape the root.
 */
export function secretFilePath(name: string): string {
  if (!name || name.length === 0) throw new Error("Secret name is empty");
  if (name === "." || name === "..") throw new Error("Invalid secret name");
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("Invalid secret name — must be a plain file name");
  }
  const p = resolve(SECRETS_DIR, name);
  const root = SECRETS_DIR.endsWith(sep) ? SECRETS_DIR : SECRETS_DIR + sep;
  if (p !== SECRETS_DIR && !p.startsWith(root)) {
    throw new Error("Secret name escapes the secret directory");
  }
  return p;
}

export type FileSafety =
  | { safe: true }
  | { safe: false; reason: string };

/** Inspect a path under the secret root without following symlinks. */
function inspectSecretFile(path: string): FileSafety {
  let st;
  try { st = lstatSync(path); } catch { return { safe: false, reason: "not accessible" }; }
  if (st.isSymbolicLink()) return { safe: false, reason: "symbolic link — refusing to follow" };
  if (!st.isFile()) return { safe: false, reason: "not a regular file" };
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    return { safe: false, reason: "wrong ownership" };
  }
  return { safe: true };
}

/** Inspect the secret directory itself without following symlinks. */
function inspectSecretDir(): FileSafety {
  let st;
  try { st = lstatSync(SECRETS_DIR); } catch { return { safe: false, reason: "missing" }; }
  if (st.isSymbolicLink()) return { safe: false, reason: "symbolic link — refusing to follow" };
  if (!st.isDirectory()) return { safe: false, reason: "not a directory" };
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    return { safe: false, reason: "wrong ownership" };
  }
  return { safe: true };
}

/** Is the secret store present and safe to write into? (never follows symlinks) */
export function secretStoreSafe(): FileSafety {
  if (!existsSync(SECRETS_DIR)) return { safe: true };
  return inspectSecretDir();
}

/**
 * Create the secret directory (0700) when absent, or narrow an owned
 * directory that is WIDER than 0700 down to 0700. More-restrictive modes
 * (e.g. 0500) are never widened. Fails closed on symlinks / wrong ownership.
 */
export function ensureSecretDir(): FileSafety {
  if (!existsSync(SECRETS_DIR)) {
    try { mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 }); }
    catch { return { safe: false, reason: "could not create secret directory" }; }
  }
  const insp = inspectSecretDir();
  if (!insp.safe) return insp;
  try {
    const st = statSync(SECRETS_DIR);
    if ((st.mode & 0o077) !== 0) chmodSync(SECRETS_DIR, 0o700);
  } catch { return { safe: false, reason: "permission narrowing failed" }; }
  return { safe: true };
}

/** Narrow an owned regular secret file to 0600. Returns false on failure. */
function narrowSecretFileMode(path: string): boolean {
  try {
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0) chmodSync(path, 0o600);
    return true;
  } catch { return false; }
}

/** Ensure the secret dir exists. Called once at import (mirrors legacy behavior). */
ensureSecretDir();

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
  let path: string;
  try { path = secretFilePath(name); } catch { return undefined; }
  if (!inspectSecretFile(path).safe) return undefined;
  // #1354: safe automatic narrowing — an owned regular file is narrowed to
  // 0600; anything unsafe was already rejected above.
  narrowSecretFileMode(path);
  try {
    const raw = readFileSync(path, "utf-8").trim();
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

/**
 * Write an encrypted secret to ~/.abtars/secret/<name>.
 * Fails closed on invalid names, unsafe store, or unsafe existing objects.
 */
export function writeSecret(name: string, value: string): void {
  if (!isValidSecretName(name)) {
    throw new Error(`Invalid secret name — use [A-Z_][A-Z0-9_]* only`);
  }
  const key = getSecretsKey();
  if (!key) throw new Error("Cannot encrypt secret: abtars.key not found. Run abtars install.");
  const dirSafe = ensureSecretDir();
  if (!dirSafe.safe) throw new Error(`Secret store unsafe: ${dirSafe.reason}`);
  const path = secretFilePath(name);
  if (existsSync(path)) {
    const existing = inspectSecretFile(path);
    if (!existing.safe) throw new Error(`Refusing to overwrite unsafe secret file (${existing.reason})`);
  }
  // crypto.encrypt already prefixes "ENC:" — pass the value directly.
  atomicWriteSync(path, encrypt(value, key), 0o600);
  cache.set(name, value);
}

/**
 * #1354: write a secret using the existing compatible wire format — encrypted
 * when the master key is available, plaintext otherwise (boot auto-encrypts).
 * Used by the boot migration, which must not fail when no key exists yet.
 */
export function writeSecretCompatible(name: string, value: string): void {
  if (!isValidSecretName(name)) {
    throw new Error(`Invalid secret name — use [A-Z_][A-Z0-9_]* only`);
  }
  const dirSafe = ensureSecretDir();
  if (!dirSafe.safe) throw new Error(`Secret store unsafe: ${dirSafe.reason}`);
  const path = secretFilePath(name);
  if (existsSync(path)) {
    const existing = inspectSecretFile(path);
    if (!existing.safe) throw new Error(`Refusing to overwrite unsafe secret file (${existing.reason})`);
  }
  const key = getSecretsKey();
  const payload = key ? encrypt(value, key) : value;
  atomicWriteSync(path, payload, 0o600);
  cache.set(name, value);
}

/**
 * Compare an existing secret against a plaintext candidate WITHOUT exposing
 * the value. `unreadable` covers missing key / undecryptable / unsafe file —
 * callers must treat it as "do not clobber, do not derive". An empty file is
 * not a usable secret and counts as missing.
 */
export function compareSecret(name: string, value: string): "missing" | "equal" | "different" | "unreadable" {
  let path: string;
  try { path = secretFilePath(name); } catch { return "unreadable"; }
  if (!existsSync(path)) return "missing";
  if (!inspectSecretFile(path).safe) return "unreadable";
  let raw: string;
  try { raw = readFileSync(path, "utf-8").trim(); } catch { return "unreadable"; }
  if (!raw) return "missing";
  const existing = readSecret(name);
  if (existing === undefined) return "unreadable";
  return existing === value ? "equal" : "different";
}

/** Clear cached secret values (for testing or reload). Does not clear the encryption key. */
export function clearSecretCache(): void { cache.clear(); }
