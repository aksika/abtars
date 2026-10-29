/**
 * worker-orc-extension.ts — #1643: canonical supervised Worker/Orc extension
 * artifact and its secure path resolution.
 *
 * The artifact (templates/pi-extensions/worker-orc-v1.ts) is the protocol v1
 * implementation loaded ONLY for durable supervised Pi runs. The versioned
 * filename versions abtars' RPC interpretation; the Pi compatibility policy
 * stays the existing pinned-installation preflight.
 */
import { isAbsolute, join, relative } from "node:path";
import { accessSync, constants, realpathSync, lstatSync } from "node:fs";
import { abtarsRoot } from "../../paths.js";

/** Protocol version of the Worker/Orc extension RPC contract. */
export const WORKER_ORC_EXTENSION_PROTOCOL = 1;

/** Logical artifact filename under templates/pi-extensions/. */
export const WORKER_ORC_EXTENSION_FILE = "worker-orc-v1.ts";

/** Canonical templates subdirectory for Pi extension artifacts. */
const WORKER_ORC_EXTENSION_DIR = "pi-extensions";

export type WorkerOrcExtensionResolution =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Resolve the canonical artifact below abtarsRoot()/templates/pi-extensions.
 * Requires a regular readable non-symlink file and rejects path escapes so a
 * tampered release can never redirect the extension load outside the release
 * tree. The error names only the versioned logical artifact — never unrelated
 * host paths.
 */
export function resolveWorkerOrcExtensionPath(): WorkerOrcExtensionResolution {
  try {
    const releaseRoot = realpathSync(abtarsRoot());
    const canonicalTemplates = realpathSync(join(releaseRoot, "templates"));
    const templatesRelativeToRelease = relative(releaseRoot, canonicalTemplates);
    if (isAbsolute(templatesRelativeToRelease) || templatesRelativeToRelease.startsWith("..")) {
      return { ok: false, error: `${WORKER_ORC_EXTENSION_FILE} is outside the active release` };
    }
    const candidate = join(canonicalTemplates, WORKER_ORC_EXTENSION_DIR, WORKER_ORC_EXTENSION_FILE);
    // The candidate is under the canonical (symlink-resolved) templates root;
    // an escape is only possible if the templates tree itself is a symlink
    // farm, which realpathSync already flattened. lstat rejects a symlink
    // final component and enforces a regular readable file.
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      return { ok: false, error: `${WORKER_ORC_EXTENSION_FILE} must be a regular file, not a symlink` };
    }
    accessSync(candidate, constants.R_OK);
    if (!stat.isFile() || stat.size <= 0) {
      return { ok: false, error: `${WORKER_ORC_EXTENSION_FILE} is missing or not a readable regular file` };
    }
    const canonicalCandidate = realpathSync(candidate);
    const candidateRelativeToTemplates = relative(canonicalTemplates, canonicalCandidate);
    if (isAbsolute(candidateRelativeToTemplates) || candidateRelativeToTemplates.startsWith("..")) {
      return { ok: false, error: `${WORKER_ORC_EXTENSION_FILE} is outside the active release` };
    }
    return { ok: true, path: canonicalCandidate };
  } catch {
    return { ok: false, error: `${WORKER_ORC_EXTENSION_FILE} is missing in the active release` };
  }
}
