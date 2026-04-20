/**
 * Migration 001: legacy ~/.agentbridge/.env.memory → ~/.agentbridge/config/.env.memory.
 *
 * Historical context: pre-158 deploy.sh had inline `mv` lines to relocate
 * .env.memory into config/. This migration captures that move as a typed,
 * idempotent module so it runs once, gets recorded in manifest, and can be
 * purged in ~6 months per plan.
 *
 * Idempotent. No-op if neither source nor dest exists, or if dest already
 * exists (never overwrite operator config).
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

export const migration001: Migration = {
  name: '001-env-memory-to-config',
  async run(ctx: MigrationContext): Promise<MigrationResult> {
    const src = join(ctx.home, '.env.memory');
    const dst = join(ctx.home, 'config', '.env.memory');
    const srcExists = await exists(src);
    const dstExists = await exists(dst);
    if (!srcExists) {
      return { name: this.name, applied: false, message: 'no legacy .env.memory to migrate' };
    }
    if (dstExists) {
      return {
        name: this.name,
        applied: false,
        message: `config/.env.memory already exists; leaving legacy ${src} in place for operator review`,
      };
    }
    if (ctx.dryRun) {
      return { name: this.name, applied: false, message: `[dry-run] would mv ${src} → ${dst}` };
    }
    await rename(src, dst);
    return { name: this.name, applied: true, message: `moved ${src} → ${dst}` };
  },
};
