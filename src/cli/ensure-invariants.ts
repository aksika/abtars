/**
 * ensure-invariants.ts — seed missing config files + run config migrations on update.
 * Called from both `abtars install` and `abtars update`. Idempotent.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { logInfo } from "../components/logger.js";

const TAG = "ensure-invariants";

interface ConfigMigration {
  id: string;
  file: string; // relative to home (e.g. "config/irc.json")
  applies: (content: string) => boolean;
  apply: (content: string) => string;
}

const MIGRATIONS: ConfigMigration[] = [
  {
    id: "irc-secure-to-signed",
    file: "config/irc.json",
    applies: (c) => c.includes('"secure"'),
    apply: (c) => c.replace(/"secure"/g, '"signed"'),
  },
];

/** Seed missing config files from install-manifest. Returns list of created files. */
export async function ensureInstallInvariants(repoRoot: string, home: string): Promise<string[]> {
  const { loadManifest } = await import("./install-manifest.js");
  const manifest = loadManifest(repoRoot);
  const created: string[] = [];

  for (const seed of manifest.configSeeds) {
    const src = join(repoRoot, seed.source);
    const dst = join(home, seed.dest);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(src, "utf-8"), { mode: seed.mode ? parseInt(seed.mode, 8) : 0o644 });
    created.push(seed.dest);
    logInfo(TAG, `Seeded missing: ${seed.dest}`);
  }

  // Run config migrations
  for (const m of MIGRATIONS) {
    const path = join(home, m.file);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf-8");
    if (!m.applies(content)) continue;
    writeFileSync(path, m.apply(content));
    logInfo(TAG, `Migrated: ${m.id} (${m.file})`);
    created.push(`[migrated] ${m.file}`);
  }

  return created;
}
