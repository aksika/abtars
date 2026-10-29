/**
 * project-workspace-reclaim.ts — #1846: reclaim orphaned per-project workspaces.
 *
 * Supervised project roots bind a workspace at `projects/<cardId>` (#1844).
 * Once kanbanCleanup(7) purges the terminal card, the directory is orphaned.
 * This module sweeps one `projects/` root per pass: a directory is removed
 * only after its card has been provably absent for a 3-day orphan grace
 * (7d terminal retention + 3d grace = 10d total). Grace is anchored on
 * first-observed-orphan via a marker file, never on mtime: by purge day 7
 * the tree is already older than the grace, so mtime would delete on first
 * sight.
 *
 * Fail-closed throughout: an unreadable database, missing table, failed
 * query, or zero-row board aborts deletions for the pass. Anything outside
 * the projects root, anything non-numeric, and anything unparseable is
 * logged and left alone.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPathWithinRoot } from "./workspace-paths.js";
import { logDebug, logInfo, logWarn } from "./logger.js";

const TAG = "project-workspace-reclaim";

/** #1846: orphan grace after confirmed card absence. Named constant matching the kanbanCleanup(7) call shape. */
export const ORPHAN_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/** Marker filename inside an orphan directory; content is epoch millis of first observation. */
export const ORPHAN_MARKER_FILENAME = ".orphan-since";

/** Minimal database surface the sweep needs; TaskDatabase satisfies it structurally. */
export interface ReclaimDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}

export interface ProjectWorkspaceReclaimSummary {
  scanned: number;
  removed: number[];
  marked: number[];
}

const EMPTY_SUMMARY: ProjectWorkspaceReclaimSummary = { scanned: 0, removed: [], marked: [] };

/**
 * Sweep one projects root, removing directories whose kanban card has been
 * absent for at least ORPHAN_GRACE_MS. Never throws for expected failure
 * states (missing root, unreadable DB, hostile entries) — those log and
 * yield an empty summary so a heartbeat tick cannot wedge on this job.
 */
export function reclaimOrphanedProjectWorkspaces(
  db: ReclaimDatabase | null,
  projectsRoot: string,
  now: () => number = Date.now,
): ProjectWorkspaceReclaimSummary {
  if (db === null) {
    logDebug(TAG, "Task database unavailable — reclaim pass does nothing");
    return { ...EMPTY_SUMMARY };
  }

  let entries: string[];
  try {
    entries = readdirSync(projectsRoot);
  } catch (err) {
    // Missing root means no supervised projects yet — the normal fresh-install state.
    if ((err as { code?: string } | null)?.code === "ENOENT") {
      logDebug(TAG, `Projects root absent — nothing to reclaim: ${projectsRoot}`);
    } else {
      logWarn(TAG, `Cannot list projects root — reclaim pass does nothing: ${projectsRoot}`);
    }
    return { ...EMPTY_SUMMARY };
  }

  // Positive predicate, proved once up front: the board must exist and hold
  // rows, or absence-of-a-card is indistinguishable from a fresh/broken
  // database (whose naive sweep would wipe every directory).
  try {
    const table = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kanban_board'`,
    ).get();
    if (table === undefined) {
      logDebug(TAG, "kanban_board table missing — reclaim pass does nothing");
      return { ...EMPTY_SUMMARY };
    }
    const total = db.prepare(`SELECT COUNT(*) AS n FROM kanban_board`).get();
    const count = typeof total?.["n"] === "number" ? total["n"] : 0;
    if (count <= 0) {
      logDebug(TAG, "kanban_board is empty — reclaim pass does nothing");
      return { ...EMPTY_SUMMARY };
    }
  } catch (err) {
    // Failed predicate query: absence of evidence is not evidence of absence.
    logWarn(TAG, `Card-absence predicate failed — reclaim pass does nothing: ${err instanceof Error ? err.message : String(err)}`);
    return { ...EMPTY_SUMMARY };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(projectsRoot);
  } catch (err) {
    logWarn(TAG, `Cannot canonicalize projects root — reclaim pass does nothing: ${err instanceof Error ? err.message : String(err)}`);
    return { ...EMPTY_SUMMARY };
  }

  const nowMs = now();
  const summary: ProjectWorkspaceReclaimSummary = { scanned: 0, removed: [], marked: [] };

  for (const name of entries) {
    const cardId = parseCandidateName(name);
    if (cardId === undefined) {
      logDebug(TAG, `Skipping non-numeric entry: ${name}`);
      continue;
    }
    const joined = join(projectsRoot, name);

    let entryLstat;
    try {
      entryLstat = lstatSync(joined);
    } catch (err) {
      logWarn(TAG, `Cannot stat candidate — skipping: ${joined} (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (entryLstat.isSymbolicLink()) {
      // A symlink cannot carry its own observation marker — writes through it
      // land in the target, possibly outside the root — and unlinking it serves
      // no reclaim goal. Refuse the entry entirely rather than follow it.
      logWarn(TAG, `Symlink entry — refusing to touch: ${joined}`);
      continue;
    }
    if (!entryLstat.isDirectory()) {
      logDebug(TAG, `Skipping non-directory entry: ${joined}`);
      continue;
    }
    // Containment is proved before any mutation (marker write included), not
    // only before the unlink: a refused candidate must have zero side effects.
    if (resolveContainedCandidate(joined, canonicalRoot) === undefined) continue;
    summary.scanned += 1;

    let cardRow: Record<string, unknown> | undefined;
    try {
      cardRow = db.prepare(`SELECT 1 AS one FROM kanban_board WHERE id = ?`).get(cardId);
    } catch (err) {
      // Mid-pass DB failure: stop deleting, keep what the pass already did.
      logWarn(TAG, `Card query failed — stopping reclaim pass: ${err instanceof Error ? err.message : String(err)}`);
      return summary;
    }

    const markerPath = join(joined, ORPHAN_MARKER_FILENAME);
    if (cardRow !== undefined) {
      // Card reappeared: a stale marker must not arm a future deletion.
      try {
        rmSync(markerPath, { force: true });
      } catch (err) {
        logWarn(TAG, `Cannot clear stale orphan marker — will retry next pass: ${markerPath} (${err instanceof Error ? err.message : String(err)})`);
      }
      continue;
    }

    const observed = readOrWriteMarker(markerPath, nowMs);
    if (observed === undefined) continue;
    if (observed === nowMs) {
      summary.marked.push(cardId);
      continue;
    }
    if (nowMs - observed < ORPHAN_GRACE_MS) continue;
    if (removeContainedDirectory(joined, canonicalRoot)) summary.removed.push(cardId);
  }

  if (summary.removed.length > 0) logInfo(TAG, `Reclaimed ${summary.removed.length} orphaned project workspaces: ${summary.removed.join(", ")}`);
  return summary;
}

/**
 * Strict canonical-decimal candidate names only: no leading zeros, signs,
 * decimals, or whitespace. ensureProjectWorkspace binds String(cardId), so a
 * conforming directory round-trips exactly; anything else is never guessed at.
 */
function parseCandidateName(name: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(name)) return undefined;
  return Number.parseInt(name, 10);
}

/**
 * Read the first-observed timestamp, writing now when the marker is absent
 * or unparseable (fail-closed: an unreadable marker never counts as aged).
 * Returns the observed millis, or undefined when neither read nor write
 * succeeded — the entry is skipped this pass either way.
 */
function readOrWriteMarker(markerPath: string, nowMs: number): number | undefined {
  try {
    const raw = readFileSync(markerPath, "utf-8").trim();
    const parsed = parseObservedAt(raw);
    if (parsed !== undefined) return parsed;
    logWarn(TAG, `Unparseable orphan marker — re-arming grace: ${markerPath}`);
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "ENOENT") {
      logWarn(TAG, `Cannot read orphan marker — skipping entry this pass: ${markerPath}`);
      return undefined;
    }
  }
  try {
    writeFileSync(markerPath, `${nowMs}\n`, "utf-8");
    logDebug(TAG, `Armed orphan grace: ${markerPath}`);
    return nowMs;
  } catch (err) {
    logWarn(TAG, `Cannot write orphan marker — skipping entry this pass: ${markerPath} (${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
}

/**
 * The whole trimmed marker must be a non-negative integer: parseInt-style
 * prefix parsing would accept garbage like "123abc" as a timestamp, and an
 * empty file must never read as epoch 0 and authorize deletion.
 */
function parseObservedAt(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Canonicalize a candidate and prove it lies strictly inside the projects
 * root. Refuses anything escaping the root and anything resolving to the
 * root itself (a `<id>` symlink pointed at `projects/` would otherwise nuke
 * the subtree). Returns the canonical path, or undefined with a logged
 * reason; callers must not touch the entry when it is undefined.
 */
function resolveContainedCandidate(joined: string, canonicalRoot: string): string | undefined {
  let candidateReal: string;
  try {
    candidateReal = realpathSync(joined);
  } catch (err) {
    logWarn(TAG, `Cannot canonicalize candidate — refusing: ${joined} (${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
  if (candidateReal === canonicalRoot || !isPathWithinRoot(canonicalRoot, candidateReal)) {
    logWarn(TAG, `Candidate escapes projects root — refusing: ${joined}`);
    return undefined;
  }
  return candidateReal;
}

/** Delete one contained candidate, re-proving containment immediately before the unlink. */
function removeContainedDirectory(joined: string, canonicalRoot: string): boolean {
  if (resolveContainedCandidate(joined, canonicalRoot) === undefined) return false;
  try {
    rmSync(joined, { recursive: true, force: true });
    return true;
  } catch (err) {
    logWarn(TAG, `Removal failed — will retry next pass: ${joined} (${err instanceof Error ? err.message : String(err)})`);
    return false;
  }
}
