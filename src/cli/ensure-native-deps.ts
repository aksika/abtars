/**
 * ensure-native-deps — verify native addons at ~/.abmind/lib/ after update (#494).
 * Non-blocking: update succeeds even if this fails.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ABMIND_HOME = process.env["ABMIND_HOME"] ?? join(homedir(), ".abmind");
const LIB_DIR = join(ABMIND_HOME, "lib");
const TOOLCHAIN_PATH = join(ABMIND_HOME, "toolchain.json");

/** Read npm path recorded during install. Falls back to "npm". */
function getNpmPath(): string {
  try {
    const tc = JSON.parse(readFileSync(TOOLCHAIN_PATH, "utf-8"));
    if (tc.npmPath) return tc.npmPath;
  } catch {}
  return "npm";
}

/** Record toolchain paths (called during install/update). */
export function recordToolchain(): void {
  try {
    const npmPath = execFileSync("which", ["npm"], { encoding: "utf-8", env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env["PATH"]}` } }).trim();
    const nodePath = execFileSync("which", ["node"], { encoding: "utf-8", env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env["PATH"]}` } }).trim();
    writeFileSync(TOOLCHAIN_PATH, JSON.stringify({ npmPath, nodePath }, null, 2) + "\n");
  } catch {}
}

export async function ensureNativeDeps(): Promise<void> {
  const nmDir = join(LIB_DIR, "node_modules");
  mkdirSync(nmDir, { recursive: true });

  // Quick check: can sqlite-vec load and find its platform binary?
  try {
    const req = createRequire(join(nmDir, "_"));
    const vec = req("sqlite-vec") as { getLoadablePath: () => string };
    vec.getLoadablePath();
    return; // all good
  } catch { /* needs install/repair */ }

  const npm = getNpmPath();
  process.stdout.write(`  Installing native deps (sqlite-vec) via ${npm}...\n`);
  execFileSync(npm, ["install", "--omit=dev", "better-sqlite3", "sqlite-vec"], {
    cwd: LIB_DIR,
    stdio: "pipe",
    timeout: 60_000,
  });
  process.stdout.write("  ✓ native deps installed\n");
}
