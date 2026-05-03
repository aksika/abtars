/**
 * `abtars status` — print manifest + lock state.
 * Read-only. Exit code 0 on healthy install, 1 otherwise.
 */

import { inspectLock, packagePaths, readCurrent, readManifest, type PriorRelease } from '../deploy-lib-import.js';

export async function status(): Promise<number> {
  const paths = packagePaths('abtars');
  const manifest = await readManifest(paths.manifest);
  const current = await readCurrent(paths.current);
  const lock = await inspectLock(paths.lock);

  if (!manifest) {
    process.stdout.write(
      `abtars: not installed (no manifest at ${paths.manifest})\n` +
        `Run 'abtars install' to set up.\n`,
    );
    return 1;
  }

  const lines = [
    `abtars status`,
    `  home:          ${paths.home}`,
    `  version:       ${manifest.version || '(unset — run update)'}`,
    `  commit:        ${manifest.commit ?? '(unknown)'}`,
    `  branch:        ${manifest.branch ?? '(unknown)'}`,
    `  source:        ${manifest.source}`,
    `  activated:     ${manifest.activatedAt}`,
    `  current ->:    ${current ?? '(missing)'}`,
    `  host:          ${manifest.host}`,
    `  prior:         ${manifest.priorReleases.length > 0 ? manifest.priorReleases.map((r: PriorRelease) => r.version).join(', ') : '(none)'}`,
  ];
  if (lock.held) {
    lines.push(
      `  lock:          HELD by pid ${lock.content.pid} (${lock.content.cmd})${lock.stale ? ' — STALE' : ''}`,
    );
  } else {
    lines.push(`  lock:          not held`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  // Surface mismatch between manifest version and current symlink target.
  if (current !== null && manifest.version !== '' && current !== manifest.version) {
    process.stderr.write(
      `\nWarning: current symlink points at '${current}' but manifest says '${manifest.version}'.\n` +
        `Re-run 'abtars update' or 'abtars rollback' to reconcile.\n`,
    );
    return 1;
  }
  return 0;
}
