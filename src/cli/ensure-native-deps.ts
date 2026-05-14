/**
 * ensure-native-deps — verify native addons at ~/.abmind/lib/ after update (#494).
 * Non-blocking: update succeeds even if this fails.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LIB_DIR = join(process.env["ABMIND_HOME"] ?? join(homedir(), ".abmind"), "lib");

export async function ensureNativeDeps(): Promise<void> {
  const nmDir = join(LIB_DIR, "node_modules");
  mkdirSync(nmDir, { recursive: true });

  // Quick check: can sqlite-vec load and find its platform binary?
  try {
    const req = createRequire(join(nmDir, "_"));
    const vec = req("sqlite-vec") as { getLoadablePath: () => string };
    vec.getLoadablePath(); // throws if platform binary missing
    return; // all good
  } catch { /* needs install/repair */ }

  process.stdout.write("  Installing native deps (sqlite-vec)...\n");
  execFileSync("npm", ["install", "--omit=dev", "better-sqlite3", "sqlite-vec"], {
    cwd: LIB_DIR,
    stdio: "pipe",
    timeout: 60_000,
  });
  process.stdout.write("  ✓ native deps installed\n");
}
