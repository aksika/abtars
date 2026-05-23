/**
 * secrets.ts — Read secrets from ~/.abtars/secrets/ directory (#597).
 * One file per secret, filename = key name, content = value.
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";

const SECRETS_DIR = join(abtarsHome(), "secrets");
const cache = new Map<string, string>();

// Ensure secrets dir exists on first import
if (!existsSync(SECRETS_DIR)) {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
}

/** Read a secret from ~/.abtars/secrets/<name>. Cached per process. */
export function readSecret(name: string): string | undefined {
  if (cache.has(name)) return cache.get(name);
  try {
    const value = readFileSync(join(SECRETS_DIR, name), "utf-8").trim();
    if (value) {
      cache.set(name, value);
      return value;
    }
    return undefined;
  } catch { return undefined; }
}

/** Clear cached secrets (for testing or reload). */
export function clearSecretCache(): void { cache.clear(); }
