import { resolvePiInstallation } from "../../components/pi-installation.js";
import { inspectPiRuntimeSurfaces } from "../../components/pi-inspector.js";
import { PI_COMPATIBILITY } from "../../config/pi-compatibility.js";

/**
 * Pi compatibility preflight for deployment activation (#1438, #1441).
 *
 * Read-only observation of the Pi installation, including a read-only probe
 * of its runtime module export surfaces (#1441) — distinguishes a package
 * that is present and version-compatible from one whose ESM export map
 * cannot actually be loaded at runtime.
 * No package mutation. All states are non-blocking — Pi is optional
 * functionality.
 */
export async function preflightPiCompatibility(): Promise<number> {
  process.stdout.write("[pi-preflight] Checking Pi compatibility...\n");

  const result = resolvePiInstallation({ useCache: false });

  switch (result.state) {
    case "absent":
      process.stdout.write("[pi-preflight] ○ Pi not installed — skipping (optional)\n");
      return 0;

    case "compatible": {
      const surfaces = inspectPiRuntimeSurfaces(result.installation);
      const unloadable = Object.entries(surfaces).filter(([, v]) => v.status === "unloadable");
      if (unloadable.length > 0) {
        process.stdout.write(
          `[pi-preflight] ⚠ Pi ${result.installation.version} installed but ${unloadable.length} runtime module surface(s) unloadable — Pi features unavailable\n`,
        );
        for (const [key, v] of unloadable) {
          process.stdout.write(`  ${key}: ${(v as { reason: string }).reason}\n`);
        }
        return 0;
      }
      process.stdout.write(
        `[pi-preflight] ✓ Pi ${result.installation.version} (minimum ${PI_COMPATIBILITY.minimumPiVersion}) — ${result.installation.source}\n`,
      );
      return 0;
    }

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
