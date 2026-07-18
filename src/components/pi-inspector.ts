import { PI_COMPATIBILITY } from "../config/pi-compatibility.js";
import {
  resolvePiInstallation, clearPiCache, resolvePiModuleUrl,
  type PiInstallationState, type PiInstallation, type PiModuleSpecifier,
} from "./pi-installation.js";

export type PiComponentState = "absent" | "compatible" | "below-minimum" | "incomplete" | "invalid";

export type PiInspection = {
  state: PiComponentState;
  executable?: string;
  packageRoot?: string;
  version?: string;
  minimum: string;
  ai: "present" | "absent";
  tui: "present" | "absent";
  core: "present" | "absent";
};

export function inspectPiInstallation(useCache = true): PiInspection {
  const result = resolvePiInstallation({ useCache });

  const base: PiInspection = {
    state: result.state,
    minimum: PI_COMPATIBILITY.minimumPiVersion,
    ai: "absent",
    tui: "absent",
    core: "absent",
  };

  if (result.state === "absent") return base;

  if (result.state === "compatible") {
    return {
      ...base,
      state: "compatible",
      executable: result.installation.executable,
      packageRoot: result.installation.packageRoot,
      version: result.installation.version,
      ai: "present",
      tui: "present",
      core: "present",
    };
  }

  return {
    ...base,
    state: result.state,
    executable: result.executable,
    packageRoot: result.packageRoot,
    version: result.observedVersion,
  };
}

/**
 * Probe Pi runtime module surfaces without executing provider requests.
 * Returns a map of component key → "loadable" | "unloadable" with the error
 * reason for unloadable surfaces. Used by diagnostics (doctor, deps, preflight)
 * to distinguish a loadable module from one that exists on disk but cannot be
 * imported due to ESM/CJS contract issues.
 *
 * Read-only: resolves export targets and validates manifest/metadata only.
 * Does not import the module (side-effect-free for preflight safety).
 */
export function inspectPiRuntimeSurfaces(
  installation: PiInstallation,
): Record<string, { status: "loadable" } | { status: "unloadable"; reason: string }> {
  const probes: Array<{ key: string; specifier: { package: PiModuleSpecifier["package"]; subpath?: string } }> = [
    { key: "ai", specifier: { package: "@earendil-works/pi-ai" } },
    { key: "ai-api", specifier: { package: "@earendil-works/pi-ai", subpath: "api/openai-completions" } },
    { key: "ai-providers", specifier: { package: "@earendil-works/pi-ai", subpath: "providers/all" } },
    { key: "tui", specifier: { package: "@earendil-works/pi-tui" } },
    { key: "agent-core", specifier: { package: "@earendil-works/pi-agent-core" } },
  ];

  const results: Record<string, { status: "loadable" } | { status: "unloadable"; reason: string }> = {};

  for (const { key, specifier } of probes) {
    try {
      resolvePiModuleUrl(installation, specifier);
      results[key] = { status: "loadable" };
    } catch (err) {
      results[key] = {
        status: "unloadable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return results;
}

export { resolvePiInstallation, clearPiCache };
export type { PiInstallationState };
