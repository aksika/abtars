/**
 * abmind-bin.ts — resolve the absolute path to the `abmind` CLI binary.
 *
 * The bridge process (started by `abtars-watchdog.sh`) has a restricted PATH
 * that does not include the nvm bin dir where the global `abmind` symlink
 * actually lives. Spawning bare `"abmind"` therefore ENOENTs. #1308 follow-up.
 *
 * This helper reuses the ordered discovery strategies from `abmind-lazy.ts`
 * (#1286) and returns the absolute path to the first valid candidate's
 * `bin.abmind` entry. Returns null if no candidate qualifies (caller falls
 * back to bare-name spawn — which then produces a loud "binary not found"
 * diagnostic in the new close handler).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { resolveAbmindPackageDir } from "./abmind-lazy.js";

/**
 * Resolve the absolute path to the `abmind` CLI bin. Returns null if no
 * candidate directory has a valid `package.json` with a `bin.abmind` entry
 * whose file exists on disk.
 *
 * `bin.abmind` is a package-dir-relative string (verified: e.g.
 * `"dist/cli/abmind.js"`). The returned path is the join of the package
 * directory and the bin entry, which may itself be a symlink to a build
 * location — Node follows the symlink on spawn, so no `readlink -f` is
 * needed.
 */
export function resolveAbmindBin(): string | null {
  const dir = resolveAbmindPackageDir();
  if (!dir) return null;
  const pkgPath = join(dir, "package.json");
  let binEntry: unknown;
  try {
    const raw = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    const bin = raw["bin"];
    if (typeof bin === "string") {
      binEntry = bin;
    } else if (bin && typeof bin === "object") {
      const obj = bin as Record<string, unknown>;
      const v = obj["abmind"];
      if (typeof v === "string") binEntry = v;
    }
  } catch {
    return null;
  }
  if (typeof binEntry !== "string" || binEntry.length === 0) return null;
  const abs = isAbsolute(binEntry) ? binEntry : join(dir, binEntry);
  return existsSync(abs) ? abs : null;
}
