/**
 * pi-preflight.ts — Pi compatibility preflight for deployment activation (#1427, #1437).
 *
 * Checks installed Pi shared packages (pi-ai, pi-tui) and the configured
 * pi-coding-agent executable before activation. Package refresh failures
 * block activation; coding-agent mismatches warn but do not block.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PI_COMPATIBILITY } from "../../config/pi-compatibility.js";
import { inspectAllPiComponents } from "../../components/pi-inspector.js";

/**
 * Run the Pi compatibility preflight.
 *
 * Refreshes installed pi-ai/pi-tui groups to the incoming target version.
 * Fatal refresh failures abort activation (return 1).
 * Coding-agent warnings (mismatch, invalid, missing binary) are logged but
 * do not block — Pi coding is optional.
 *
 * Returns 0 to proceed, 1 to abort activation.
 */
export async function preflightPiCompatibility(): Promise<number> {
  process.stdout.write("[pi-preflight] Checking Pi compatibility...\n");

  let execCommand: string | undefined;
  try {
    const { loadPiConfig } = await import("../../components/pi-executor/config.js");
    const config = loadPiConfig();
    execCommand = config?.command;
  } catch { /* config may not be available */ }

  const statuses = inspectAllPiComponents({ command: execCommand });
  const pkgStatuses = statuses.filter(s => s.component === "ai" || s.component === "tui");
  const execStatus = statuses.find(s => s.component === "coding-agent");
  let ok = true;

  for (const s of pkgStatuses) {
    const group = s.component === "ai" ? "provider" : "tui";
    if (s.state === "missing") {
      process.stdout.write(`[pi-preflight] ○ ${group} not installed — skipping\n`);
      continue;
    }
    if (s.state !== "ok") {
      process.stdout.write(`[pi-preflight] → refreshing ${group} (${s.state})...\n`);
      const libDir = join(homedir(), ".local", "lib");
      const pkgInfo = s.component === "ai" ? PI_COMPATIBILITY.packages.ai : PI_COMPATIBILITY.packages.tui;
      const args: string[] = [
        "install", "--prefix", libDir, "--no-audit", "--no-fund",
        `${pkgInfo.name}@${pkgInfo.version}`,
      ];
      const result = spawnSync("npm", args, { stdio: "pipe", shell: false, encoding: "utf-8" });
      if (result.error || result.status !== 0) {
        process.stderr.write(
          `[pi-preflight] ✗ ${group} refresh failed: ${result.error?.message ?? result.stderr?.slice(0, 200) ?? `exit ${result.status}`}\n`,
        );
        ok = false;
      } else {
        process.stdout.write(`[pi-preflight] ✓ ${group} refreshed\n`);
      }
    }
  }

  let execWarning = false;
  if (execStatus) {
    if (execStatus.state === "ok") {
      process.stdout.write(`[pi-preflight] ✓ coding-agent ${execStatus.observed}\n`);
    } else if (execStatus.state === "missing" && !execCommand) {
      // No Pi executor configured — silent
    } else {
      process.stderr.write(
        `[pi-preflight] ⚠ coding-agent: ${execStatus.state}${execStatus.observed ? " (found " + execStatus.observed + ")" : ""} — expected ${execStatus.expected}\n`,
      );
      if (execStatus.remediation) {
        process.stderr.write(`  ${execStatus.remediation}\n`);
      }
      execWarning = true;
    }
  }

  if (!ok) {
    process.stderr.write("[pi-preflight] ✗ Preflight failed — aborting activation\n");
    return 1;
  }

  if (execWarning) {
    process.stdout.write(
      "[pi-preflight] ⚠ Pi compatibility: continuing despite coding-agent warning (see above)\n",
    );
  } else {
    process.stdout.write("[pi-preflight] ✓ Pi compatibility check passed\n");
  }
  return 0;
}
