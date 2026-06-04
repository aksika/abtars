/**
 * `abtars status` — print manifest + bridge state.
 * Read-only. Exit code 0 on healthy install, 1 otherwise.
 */

import { existsSync } from 'node:fs';
import { packagePaths, readManifest, readSentinel } from '../deploy-lib-import.js';
import { readFileSync } from "node:fs";
import { join } from "node:path";

export async function status(): Promise<number> {
  const paths = packagePaths('abtars');
  const manifest = await readManifest(paths.manifest);

  if (!manifest) {
    process.stdout.write(
      `abtars: not installed (no manifest at ${paths.manifest})\n` +
        `Run 'abtars install' to set up.\n`,
    );
    return 1;
  }

  const appExists = existsSync(paths.app);
  const appPrevExists = existsSync(paths.appPrev);

  const lines = [
    `abtars status`,
    `  home:          ${paths.home}`,
    `  version:       ${manifest.version || '(unset — run update)'}`,
    `  commit:        ${manifest.commit ?? '(unknown)'}`,
    `  branch:        ${manifest.branch ?? '(unknown)'}`,
    `  source:        ${manifest.source}`,
    `  mode:          ${manifest.installMode ?? 'supervised'}`,
    `  activated:     ${manifest.activatedAt}`,
    `  app/:          ${appExists ? '✓ present' : '✗ missing'}`,
    `  app.prev/:     ${appPrevExists ? '✓ present' : '○ none'}`,
    `  previous:      ${manifest.previousVersion ?? '(none)'}`,
    `  host:          ${manifest.host}`,
  ];

  // Bridge state
  try {
    const bridgeLock = JSON.parse(readFileSync(join(paths.home, 'bridge.lock'), 'utf-8'));
    if (bridgeLock.pid) {
      const alive = (() => { try { process.kill(bridgeLock.pid, 0); return true; } catch { return false; } })();
      lines.push(`  bridge:        ${alive ? '● running' : '✗ dead'} (pid ${bridgeLock.pid})`);
    } else {
      lines.push(`  bridge:        ○ stopped`);
    }
  } catch {
    lines.push(`  bridge:        ○ stopped`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);

  // Sentinel warning
  const sentinel = readSentinel(paths.home);
  if (sentinel?.status === 'pending') {
    const age = Date.now() - new Date(sentinel.startedAt).getTime();
    if (age > 5 * 60_000) {
      process.stderr.write(`\n⚠️ Last update (${sentinel.version}) may have failed — bridge never confirmed boot.\n`);
      return 1;
    }
  }

  if (!appExists) {
    process.stderr.write(`\n⚠️ app/ directory missing. Run 'abtars update' to deploy.\n`);
    return 1;
  }

  return 0;
}
