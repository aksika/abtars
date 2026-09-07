/**
 * pi-selection.ts — #1780 pure Pi runtime selection/validation.
 *
 * Maps the `--pi` CLI selection to an exact npm package spec and carries the
 * requested exact version into bounded runtime evidence. No I/O, no installs —
 * the CLI orchestrator owns side effects. All functions are pure and throw
 * `Error` on invalid input so the harness fails before installing a candidate.
 */

export type PiSelectionKind = "installed" | "latest" | "pinned" | "exact";

/** Strict exact semver: `MAJOR.MINOR.PATCH` digits only, no ranges or tags. */
export const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export interface PiSelectionRequest {
  pi: string;
  piVersion?: string;
}

export interface PiSelection {
  kind: PiSelectionKind;
  /** Present only for `exact` — the validated requested version. */
  requestedVersion?: string;
}

/**
 * Validate an exact version argument. Rejects missing, malformed, and range
 * values before any candidate is installed. Returns the validated version.
 */
export function validateExactPiVersion(version: string | undefined): string {
  if (version === undefined || version.trim() === "") {
    throw new Error(
      `--pi exact requires --pi-version <exact-semver> (got missing)`,
    );
  }
  if (!EXACT_VERSION_PATTERN.test(version)) {
    throw new Error(
      `--pi-version must be an exact MAJOR.MINOR.PATCH version (got ${JSON.stringify(version)})`,
    );
  }
  return version;
}

/**
 * Parse and validate the `--pi` / `--pi-version` CLI pair. `--pi-version` is
 * required only for `exact` and rejected for every other selection so a stray
 * version can never be mislabeled as the verdict for a different source.
 */
export function parsePiSelection(request: PiSelectionRequest): PiSelection {
  const { pi, piVersion } = request;
  if (pi !== "installed" && pi !== "latest" && pi !== "pinned" && pi !== "exact") {
    throw new Error(
      `--pi must be installed, latest, pinned, or exact (got ${JSON.stringify(pi)})`,
    );
  }
  if (pi === "exact") {
    return { kind: "exact", requestedVersion: validateExactPiVersion(piVersion) };
  }
  if (piVersion !== undefined) {
    throw new Error(
      `--pi-version is only valid with --pi exact (got --pi ${pi} with version ${JSON.stringify(piVersion)})`,
    );
  }
  return { kind: pi };
}

/**
 * Resolve the npm package spec for a disposable Pi install. Returns null for
 * `installed` (no install — the host executable is used directly).
 */
export function resolvePiPackageSpec(
  selection: PiSelection,
  opts: { packageName: string; pinnedRange: string },
): string | null {
  switch (selection.kind) {
    case "installed":
      return null;
    case "latest":
      return `${opts.packageName}@latest`;
    case "pinned":
      return `${opts.packageName}@${opts.pinnedRange}`;
    case "exact":
      return `${opts.packageName}@${selection.requestedVersion}`;
  }
}
