/**
 * Migration runner scaffold (#158 Phase 1).
 *
 * Migrations are named <NNN>-<slug>.ts under src/migrations/<NNN>-*.ts and
 * export a default function matching Migration. They mutate package state
 * idempotently and log themselves into manifest.migrationsApplied.
 *
 * Phase 1 ships only `003-flat-to-releases` (registered in Phase 1c).
 * Migrations 001/002 (.env.memory / .env.skills path moves) come in Phase 2.
 *
 * Registration is explicit (static import below) rather than glob-scan to
 * avoid the dynamic-import ESM trap and give TS full visibility.
 */

import { readManifest, writeManifest } from '../deploy-lib-import.js';
import { join } from 'node:path';
import { migration001 } from './001-env-memory-to-config.js';
import { migration002 } from './002-env-skills-to-config.js';

export interface MigrationContext {
  readonly home: string;
  readonly dryRun: boolean;
}

export interface MigrationResult {
  readonly name: string;
  readonly applied: boolean;
  readonly message: string;
}

export interface Migration {
  readonly name: string;
  run(ctx: MigrationContext): Promise<MigrationResult>;
}

const REGISTRY: readonly Migration[] = [migration001, migration002];

export async function runMigrations(opts: {
  readonly home: string;
  readonly dryRun: boolean;
  readonly only?: readonly string[];
}): Promise<MigrationResult[]> {
  const manifestPath = join(opts.home, 'manifest.json');
  const manifest = await readManifest(manifestPath);
  const alreadyApplied = new Set(manifest?.migrationsApplied ?? []);
  const results: MigrationResult[] = [];

  for (const migration of REGISTRY) {
    if (opts.only !== undefined && !opts.only.includes(migration.name)) continue;
    if (alreadyApplied.has(migration.name)) {
      results.push({ name: migration.name, applied: false, message: 'already applied' });
      continue;
    }
    const result = await migration.run({ home: opts.home, dryRun: opts.dryRun });
    results.push(result);
    if (result.applied && !opts.dryRun && manifest) {
      await writeManifest(manifestPath, {
        ...manifest,
        migrationsApplied: [...manifest.migrationsApplied, migration.name],
      });
    }
  }
  return results;
}

export { REGISTRY };
