import { resolvePiInstallation } from "../../components/pi-installation.js";
import { PI_COMPATIBILITY } from "../../config/pi-compatibility.js";

/**
 * Pi compatibility preflight for deployment activation (#1438).
 *
 * Read-only observation of the Pi installation. No package mutation.
 * All states (absent, compatible, below-minimum, incomplete, invalid)
 * are non-blocking — Pi is optional functionality.
 */
export async function preflightPiCompatibility(): Promise<number> {
  process.stdout.write("[pi-preflight] Checking Pi compatibility...\n");

  const result = resolvePiInstallation({ useCache: false });

  switch (result.state) {
    case "absent":
      process.stdout.write("[pi-preflight] ○ Pi not installed — skipping (optional)\n");
      return 0;

    case "compatible":
      process.stdout.write(
        `[pi-preflight] ✓ Pi ${result.installation.version} (minimum ${PI_COMPATIBILITY.minimumPiVersion}) — ${result.installation.source}\n`,
      );
      return 0;

    case "below-minimum":
      process.stdout.write(
        `[pi-preflight] ⚠ Pi ${result.observedVersion} below minimum ${PI_COMPATIBILITY.minimumPiVersion} — Pi features unavailable\n` +
        `  ${result.remediation}\n`,
      );
      return 0;

    case "incomplete":
      process.stdout.write(
        `[pi-preflight] ⚠ Pi installation incomplete: ${result.reason}\n` +
        `  ${result.remediation}\n`,
      );
      return 0;

    case "invalid":
      process.stdout.write(
        `[pi-preflight] ⚠ Pi installation invalid: ${result.reason}\n` +
        `  ${result.remediation}\n`,
      );
      return 0;
  }

  return 0;
}
