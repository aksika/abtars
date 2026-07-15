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

  // --- Seed sleep-cycle from template if absent (#1321) ---
  seedSleepCycle(templatesSrc, home);

  // --- Legacy cleanup (remove old paths, idempotent) ---
  for (const rel of LEGACY_CLEANUP) {
    const p = join(home, rel);
    if (!existsSync(p)) continue;
    rmSync(p, { recursive: true, force: true });
    logInfo(TAG, `Removed legacy: ${rel}`);
  }
}

/** Seed sleep-cycle from template if absent from the user tasks file (#1321). */
function seedSleepCycle(templatesSrc: string, home: string): void {
  const templatePath = join(templatesSrc, "tasks", "tasks.json");
  if (!existsSync(templatePath)) return;
  let sleepEntry: unknown;
  try {
    const raw = JSON.parse(readFileSync(templatePath, "utf-8"));
    if (Array.isArray(raw)) sleepEntry = raw.find((e: unknown) => e !== null && typeof e === "object" && "id" in (e as Record<string, unknown>) && (e as Record<string, unknown>).id === "sleep-cycle");
  } catch { /* skip */ }
  if (!sleepEntry) return;

  const tasksPath = join(home, "tasks", "tasks.json");
  let entries: unknown[] = [];
  try {
    if (existsSync(tasksPath)) {
      const raw = JSON.parse(readFileSync(tasksPath, "utf-8"));
      if (Array.isArray(raw)) entries = raw;
    }
  } catch (err) {
    logInfo(TAG, `tasks.json unreadable — skipping sleep-cycle seed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const exists = entries.some(e => typeof e === "object" && e !== null && (e as { id?: string }).id === "sleep-cycle");
  if (exists) return;

  entries.push(sleepEntry);
  mkdirSync(dirname(tasksPath), { recursive: true });
  writeFileSync(tasksPath, JSON.stringify(entries, null, 2), "utf-8");
  logInfo(TAG, "Seeded sleep-cycle from template");
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

  // #1420: remove legacy title keys from tasks.json entries
  const tasksPath = join(home, "tasks", "tasks.json");
  if (existsSync(tasksPath)) {
    try {
      const raw = readFileSync(tasksPath, "utf-8");
      const entries = JSON.parse(raw);
      if (Array.isArray(entries)) {
        let changed = false;
        for (const entry of entries) {
          if (entry && typeof entry === "object" && "title" in entry) {
            delete (entry as Record<string, unknown>).title;
            changed = true;
          }
        }
        if (changed) {
          writeFileSync(tasksPath, JSON.stringify(entries, null, 2), "utf-8");
          logInfo(TAG, "Migrated: removed legacy title keys from tasks.json");
        }
      }
    } catch (err) {
      logInfo(TAG, `tasks.json migration skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
