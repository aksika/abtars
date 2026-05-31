/**
 * `abtars restore` — extract user data from backup archive to ~/.abtars/
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { abtarsHome } from "../../paths.js";

export async function restore(archivePath: string): Promise<number> {
  if (!archivePath) {
    process.stderr.write("Usage: abtars restore <file.zip|.7z>\n");
    return 1;
  }
  if (!existsSync(archivePath)) {
    process.stderr.write(`File not found: ${archivePath}\n`);
    return 1;
  }

  const home = abtarsHome();
  const is7z = archivePath.endsWith(".7z");

  // Sanity check: verify archive contains config/
  const listCmd = is7z
    ? spawnSync("7z", ["l", archivePath], { encoding: "utf-8" })
    : spawnSync("unzip", ["-l", archivePath], { encoding: "utf-8" });
  if (!listCmd.stdout?.includes("config/")) {
    process.stderr.write("Error: archive does not contain config/ — not a valid abtars backup\n");
    return 1;
  }

  // Extract
  let result;
  if (is7z) {
    result = spawnSync("7z", ["x", `-o${home}`, "-aoa", archivePath], { encoding: "utf-8", stdio: "inherit" });
  } else {
    result = spawnSync("unzip", ["-o", archivePath, "-d", home], { encoding: "utf-8", stdio: "inherit" });
  }

  if (result.status !== 0) {
    process.stderr.write("Restore failed\n");
    return 1;
  }

  process.stdout.write(`✓ Restored to ${home}\n`);
  return 0;
}
