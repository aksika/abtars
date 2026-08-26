export const PI_COMPATIBILITY = {
  packageName: "@earendil-works/pi-coding-agent",
  /** The Pi version abtars is built and tested against. Single source of truth. */
  pinnedVersion: "0.84.2",
  /** npm spec used for every abtars-driven Pi install. Patch releases accepted. */
  pinnedRange: "~0.84.2",
  nestedPackages: {
    ai: "@earendil-works/pi-ai",
    tui: "@earendil-works/pi-tui",
    agentCore: "@earendil-works/pi-agent-core",
  },
} as const;

export type PiPinStatus = "at-pin" | "above-pin";

/**
 * Classify an installed Pi version against the pin. Callers only reach this
 * with a version at or above `pinnedVersion` — anything below is already
 * `below-minimum` from `resolvePiInstallation()`.
 * at-pin    → same major.minor as the pin (patch may differ)
 * above-pin → newer minor or major
 */
export function classifyPiPin(version: string): PiPinStatus {
  const parse = (v: string): { major: number; minor: number } | null => {
    const m = v.match(/^(\d+)\.(\d+)(?:\.|$)/);
    if (!m) return null;
    return { major: +m[1]!, minor: +m[2]! };
  };
  const installed = parse(version);
  const pinned = parse(PI_COMPATIBILITY.pinnedVersion);
  if (!installed || !pinned) return "above-pin";
  if (installed.major > pinned.major) return "above-pin";
  if (installed.major === pinned.major && installed.minor > pinned.minor) return "above-pin";
  return "at-pin";
}

/**
 * The exact npm command abtars drives to install the tested Pi version. Single
 * source used by warnings and runtime-contract remediation text (#1573).
 */
export function formatPiPinnedInstallCommand(): string {
  return `npm i -g '${PI_COMPATIBILITY.packageName}@${PI_COMPATIBILITY.pinnedRange}'`;
}

/**
 * Operator-facing warning for an above-pin installation, including the exact
 * downgrade command. Returns null for at-pin. Single source for the text used
 * by status, deps, preflight, boot, and tui.
 */
export function formatPiPinWarning(version: string): string | null {
  if (classifyPiPin(version) === "at-pin") return null;
  const pinLabel = PI_COMPATIBILITY.pinnedVersion.replace(/\.\d+$/, ".x");
  return (
    `Pi ${version} is newer than the version abtars is built against (${pinLabel}).\n` +
    `Pi features may fail. To return to the tested version:\n` +
    `  ${formatPiPinnedInstallCommand()}`
  );
}
