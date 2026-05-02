/**
 * Migration 002: legacy ~/.abtars/.env.skills → ~/.abtars/config/.env.skills.
 *
 * See 001-env-memory-to-config.ts for rationale. Same shape, different file.
 */

import { rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Migration, MigrationContext, MigrationResult } from './index.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export const migration002: Migration = {
  name: '002-env-skills-to-config',
  async run(ctx: MigrationContext): Promise<MigrationResult> {
    const src = join(ctx.home, '.env.skills');
    const dst = join(ctx.home, 'config', '.env.skills');
    const srcExists = await exists(src);
    const dstExists = await exists(dst);
    if (!srcExists) {
      return { name: this.name, applied: false, message: 'no legacy .env.skills to migrate' };
    }
    if (dstExists) {
      return {
        name: this.name,
        applied: false,
        message: `config/.env.skills already exists; leaving legacy ${src} in place for operator review`,
      };
    }
    if (ctx.dryRun) {
      return { name: this.name, applied: false, message: `[dry-run] would mv ${src} → ${dst}` };
    }
    await rename(src, dst);
    return { name: this.name, applied: true, message: `moved ${src} → ${dst}` };
  },
};
