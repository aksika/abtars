import { PI_COMPATIBILITY } from "../config/pi-compatibility.js";
import { resolvePiInstallation, clearPiCache, type PiInstallationState } from "./pi-installation.js";

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

export { resolvePiInstallation, clearPiCache };
export type { PiInstallationState };
