/**
 * abtars uninstall — stop everything, remove ~/.abtars/ and CLI symlinks.
 *
 * Destructive. Requires typing "uninstall" to confirm (or --yes flag).
 */

import { existsSync, readdirSync, unlinkSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stop } from "./stop.js";
import { abtarsHome } from "../../paths.js";


function binDir(): string {
  return join(process.env["HOME"] ?? "", ".local", "bin");
}

async function confirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question("⚠️  This will DELETE ~/.abtars/ entirely. Type 'uninstall' to confirm: ", (answer) => {
      rl.close();
      resolve(answer.trim() === "uninstall");
    });
  });
}

function removeSymlinks(): string[] {
  const dir = binDir();
  if (!existsSync(dir)) return [];
  const home = abtarsHome();
  const removed: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith("abtars")) continue;
    const full = join(dir, entry);
    try {
      const target = readlinkSync(full);
      if (target.includes(home) || target.includes(".abtars")) {
        unlinkSync(full);
        removed.push(entry);
      }
    } catch { /* not a symlink or already gone */ }
  }
  return removed;
}

function unloadLaunchd(): void {
  if (process.platform !== "darwin") return;
  const plist = join(process.env["HOME"] ?? "", "Library", "LaunchAgents", "com.abtars.watchdog.plist");
  if (!existsSync(plist)) return;
  try {
    const { execSync } = require("node:child_process");
    execSync(`launchctl bootout gui/$(id -u) "${plist}" 2>/dev/null`, { stdio: "ignore" });
    unlinkSync(plist);
  } catch { /* already unloaded or missing */ }
}

export async function uninstall(opts: { yes?: boolean }): Promise<number> {
  const home = abtarsHome();

  if (!existsSync(home)) {
    process.stdout.write("Nothing to uninstall — ~/.abtars/ does not exist.\n");
    return 0;
  }

  if (!opts.yes) {
    const confirmed = await confirm();
    if (!confirmed) {
      process.stdout.write("Aborted.\n");
      return 1;
    }
  }

  // 1. Stop bridge + watchdog
  await stop({ force: true });

  // 2. Unload launchd plist
  unloadLaunchd();

  // 3. Remove CLI symlinks
  const removed = removeSymlinks();

  // 4. Remove ~/.abtars/
  rmSync(home, { recursive: true, force: true });

  // 5. Summary
  process.stdout.write(`\n✓ Uninstalled abtars\n`);
  process.stdout.write(`  Removed: ${home}/\n`);
  if (removed.length > 0) {
    process.stdout.write(`  Symlinks removed: ${removed.join(", ")}\n`);
  }
  process.stdout.write(`\n  Source repo (~/abtars/) is untouched.\n`);
  return 0;
}
