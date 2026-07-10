/**
 * version-compare.ts — semver-aware version comparison.
 *
 * Used by /software to label "ahead of npm" vs "behind npm" vs "match".
 * Handles the "MAJOR.MINOR.PATCH[-PRERELEASE][-COMMITSHA]" shape produced
 * by abtars dev deploys (commit short-SHA appended, e.g. "0.3.5-alpha.0-
 * ab5e7ef"). Strict semver uses "+" for build metadata; we accept "-" and
 * treat the commit-suffix as build metadata (ignored for ordering).
 */

/** Semver compare. Positive: a > b. Negative: a < b. Zero: equal. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): { major: number; minor: number; patch: number; pre: string | null } | null => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    if (!m) return null;
    return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const stripCommit = (p: string) => p.replace(/-[0-9a-f]{7,}$/i, "");
  const sa = stripCommit(pa.pre);
  const sb = stripCommit(pb.pre);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Format a /software version-compare badge. */
export function versionBadge(deployed: string, npm: string): string {
  const cmp = compareSemver(deployed, npm);
  if (cmp === 0) return "✓";
  if (cmp > 0) return "✓ (ahead of npm)";
  return "⚠️ (behind npm)";
}
