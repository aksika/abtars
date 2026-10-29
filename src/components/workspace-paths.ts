import { isAbsolute, relative, sep } from "node:path";

/**
 * Component-aware containment for already-canonical absolute paths.
 *
 * This lives outside executor-specific modules so Worker evidence verification
 * can share the same boundary without importing Pi configuration or provider
 * behavior.
 */
export interface PathOps {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

export function isPathWithinRoot(
  canonicalRoot: string,
  canonicalCandidate: string,
  pathOps: PathOps = { relative, isAbsolute, sep },
): boolean {
  const rel = pathOps.relative(canonicalRoot, canonicalCandidate);
  if (rel === "") return true;
  if (pathOps.isAbsolute(rel)) return false;
  if (rel === "..") return false;
  if (rel.startsWith(`..${pathOps.sep}`)) return false;
  return true;
}
