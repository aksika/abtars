/**
 * First-touch hint system — show a hint once, persist to manifest.
 * Output to stderr with 💡 prefix. Never corrupts manifest (atomic write).
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

function manifestPath(): string {
  const home = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "", ".abtars");
  return join(home, "manifest.json");
}

function readManifest(): Record<string, unknown> {
  const path = manifestPath();
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return {}; }
}

function writeManifestAtomic(data: Record<string, unknown>): void {
  const path = manifestPath();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

export function showHintOnce(id: string, text: string): void {
  const manifest = readManifest();
  const seen = (manifest["hintsSeen"] as Record<string, string> | undefined) ?? {};
  if (seen[id]) return;

  process.stderr.write(`\n💡 ${text}\n\n`);

  seen[id] = new Date().toISOString();
  manifest["hintsSeen"] = seen;
  writeManifestAtomic(manifest);
}
