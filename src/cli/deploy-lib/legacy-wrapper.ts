import { lstatSync, readFileSync } from "node:fs";

export type LegacyWrapperOwnership =
  | "abtars-generated"
  | "npm-symlink"
  | "unknown"
  | "missing";

const MULTI_RESOLUTION_MARKER = "# Resolve abmind CLI — global install is canonical under #1243 (no longer bundled in the release)";
const BUNDLED_PATH_MARKER = "abmind CLI wrappers — point at the bundled copy inside the release";
const RECOGNIZED_MARKERS = [MULTI_RESOLUTION_MARKER, BUNDLED_PATH_MARKER];

export function classifyLegacyAbmindWrapper(path: string): LegacyWrapperOwnership {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "missing";
  }

  if (stat.isSymbolicLink()) {
    return "npm-symlink";
  }

  if (!stat.isFile()) {
    return "unknown";
  }

  try {
    const content = readFileSync(path, "utf-8");
    if (RECOGNIZED_MARKERS.some((m) => content.includes(m))) {
      return "abtars-generated";
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}
