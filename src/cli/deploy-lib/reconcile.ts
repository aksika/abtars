/**
 * reconcile.ts — Guarantee correct runtime tree after deploy/restore.
 * OVERWRITE: source-controlled dirs (always replaced from templates).
 * SEED: user-owned files (created if missing, never overwritten).
 */

import { existsSync, mkdirSync, rmSync, cpSync, copyFileSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { logInfo } from "../../components/logger.js";
import { resolveReleasesDir } from "./paths.js";

const TAG = "reconcile";

/** Dirs under templates/ that are always overwritten (source-controlled). */
const OVERWRITE: string[][] = [
  ["skills"],   // templates/skills/ → ~/.abtars/skills/core/
  ["prompts"],  // templates/prompts/ → ~/.abtars/prompts/
];

/** Dirs under templates/ that are seeded file-by-file (skip existing). */
const SEED = ["config", "tasks"];

/** Legacy paths to remove (one-time cleanup, idempotent). */
const LEGACY_CLEANUP = ["core/prompts", "core"];

/**
 * Reconcile runtime tree from templates source.
 * @param templatesSrc - Path to templates/ (from deployed release or source checkout)
 * @param home - Path to ~/.abtars/
 */
export function reconcile(templatesSrc: string, home: string): void {
  if (!existsSync(templatesSrc)) {
    // Fallback: try source checkout
    const fallback = join(resolveReleasesDir(), "src", "abtars", "templates");
    if (existsSync(fallback)) {
      return reconcile(fallback, home);
    }
    logInfo(TAG, `Templates not found at ${templatesSrc} — skipping`);
    return;
  }

  // --- OVERWRITE: source-controlled dirs ---
  for (const parts of OVERWRITE) {
    const src = join(templatesSrc, ...parts);
    // skills → ~/.abtars/skills/core/ (preserve custom/, self/)
    // prompts → ~/.abtars/prompts/
    const dst = parts[0] === "skills"
      ? join(home, "skills", "core")
      : join(home, ...parts);
    if (!existsSync(src)) continue;
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
  }
  logInfo(TAG, "Overwrite: skills/core, prompts");

  // --- SEED: user-owned files (create if missing) ---
  let seeded = 0;
  for (const dir of SEED) {
    const src = join(templatesSrc, dir);
    if (!existsSync(src)) continue;
    for (const f of walkFiles(src)) {
      const rel = relative(src, f);
      const dst = join(home, dir, rel);
      if (existsSync(dst)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(f, dst);
      seeded++;
    }
  }
  if (seeded > 0) logInfo(TAG, `Seeded ${seeded} missing config/task file(s)`);

  // --- Legacy cleanup (remove old paths, idempotent) ---
  for (const rel of LEGACY_CLEANUP) {
    const p = join(home, rel);
    if (!existsSync(p)) continue;
    rmSync(p, { recursive: true, force: true });
    logInfo(TAG, `Removed legacy: ${rel}`);
  }
}

/** Recursively list all files under a directory. */
function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
}

/** Config format migrations (idempotent). */
export function migrate(home: string): void {
  // #1185: move ~/.abtars/lib/ → ~/.abtars-releases/deps/
  const oldLib = join(home, "lib");
  if (existsSync(join(oldLib, "node_modules"))) {
    const { homedir } = require("node:os");
    const newDeps = join(homedir(), ".abtars-releases", "deps");
    if (!existsSync(newDeps)) {
      const { renameSync } = require("node:fs");
      renameSync(oldLib, newDeps);
      logInfo(TAG, "Migrated: ~/.abtars/lib/ → ~/.abtars-releases/deps/");
    } else {
      rmSync(oldLib, { recursive: true, force: true });
      logInfo(TAG, "Removed: ~/.abtars/lib/ (deps already at new location)");
    }
  }

  // irc-secure-to-signed: rename "secure" → "signed" in irc.json
  const ircPath = join(home, "config", "irc.json");
  if (existsSync(ircPath)) {
    const content = readFileSync(ircPath, "utf-8");
    if (content.includes('"secure"')) {
      writeFileSync(ircPath, content.replace(/"secure"/g, '"signed"'));
      logInfo(TAG, "Migrated: irc-secure-to-signed");
    }
  }
}
