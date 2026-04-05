/**
 * Path validation — prevent directory traversal outside allowed root.
 */

import { resolve } from "node:path";

/** Returns true if candidatePath resolves within rootDir. */
export function isWithinRoot(candidatePath: string, rootDir: string): boolean {
  const resolved = resolve(rootDir, candidatePath);
  return resolved.startsWith(resolve(rootDir) + "/") || resolved === resolve(rootDir);
}
