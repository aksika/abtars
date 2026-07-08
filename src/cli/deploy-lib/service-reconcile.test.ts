/**
 * Drift guards for the watchdog service-definition reconcile (#1284).
 *
 * The bug: emergency-update.sh (the zero-dependency bash fallback) skipped the
 * plist-reconcile step that deploy.ts performs, so it bootstrapped a stale
 * plist whose ProgramArguments pointed at a nonexistent release-dir path
 * (~/.abtars-releases/current/scripts/...). launchctl bootstrap failed and the
 * watchdog never started.
 *
 * These tests do NOT couple the two deploy paths (they are intentionally
 * independent — see abtars.md, emergency-update is pure foolproof bash). They
 * assert the two invariants that let them stay independent without drifting:
 *
 *  A. The service templates point at the persistent SOURCE CHECKOUT, not a
 *     release dir or a copied path. (Locks the agreed resilient design.)
 *  B. emergency-update.sh renders + writes the service definition from the repo
 *     template BEFORE it bootstraps. (Catches the exact step that was missing.)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scriptsDir = join(repoRoot, "scripts");

/** The one true watchdog script path — persistent source checkout, refreshed by git pull. */
const EXPECTED_SUFFIX = ".abtars-releases/src/abtars/scripts/abtars-watchdog.sh";

describe("deploy-lib/service-reconcile — path lock (Test A)", () => {
  it("macOS plist ProgramArguments points at the source checkout, not a release dir", () => {
    const plist = readFileSync(join(scriptsDir, "com.abtars.watchdog.plist"), "utf-8");
    const rendered = plist.replace(/\{\{HOME\}\}/g, "/Users/tester");
    // Extract the ProgramArguments script path (first <string> after the key).
    const match = rendered.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);
    expect(match, "ProgramArguments <string> not found in plist").not.toBeNull();
    const scriptPath = match![1]!;
    expect(scriptPath).toBe(`/Users/tester/${EXPECTED_SUFFIX}`);
    // Guard against regressing to the stale release-dir scheme.
    expect(scriptPath).not.toContain("/current/");
    expect(scriptPath).not.toContain("/.abtars/scripts/");
  });

  it("systemd unit ExecStart points at the source checkout, not a release dir", () => {
    const unit = readFileSync(join(scriptsDir, "abtars-watchdog.service"), "utf-8");
    const execStart = unit.match(/^ExecStart=(.+)$/m)?.[1];
    expect(execStart, "ExecStart not found in service unit").toBeDefined();
    // systemd uses %h for home.
    expect(execStart).toBe(`%h/${EXPECTED_SUFFIX}`);
    expect(execStart).not.toContain("/current/");
    expect(execStart).not.toContain("/.abtars/scripts/");
  });
});

describe("deploy-lib/service-reconcile — mirror invariant (Test B)", () => {
  const script = readFileSync(join(scriptsDir, "emergency-update.sh"), "utf-8");
  const lines = script.split("\n");

  it("emergency-update.sh renders the plist from the repo template", () => {
    // Must derive the deployed plist from the source-of-truth template,
    // not trust whatever stale plist already sits on disk.
    expect(script).toContain("scripts/com.abtars.watchdog.plist");
    // {{HOME}} substitution present (template is rendered, not blindly copied).
    expect(script).toMatch(/\{\{HOME\}\}/);
  });

  it("emergency-update.sh writes the plist BEFORE it bootstraps (macOS)", () => {
    const writeIdx = lines.findIndex(
      (l) => l.includes("com.abtars.watchdog.plist") && l.includes('> "$PLIST"'),
    );
    const bootstrapIdx = lines.findIndex((l) => l.includes("launchctl bootstrap"));
    expect(writeIdx, "no line renders the plist to $PLIST").toBeGreaterThanOrEqual(0);
    expect(bootstrapIdx, "no launchctl bootstrap found").toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeLessThan(bootstrapIdx);
  });

  it("emergency-update.sh installs the systemd unit BEFORE it starts (Linux)", () => {
    const writeIdx = lines.findIndex(
      (l) =>
        l.includes("abtars-watchdog.service") &&
        l.includes("systemd/user"),
    );
    const startIdx = lines.findIndex((l) => l.includes("systemctl --user start abtars-watchdog"));
    expect(writeIdx, "no line installs the systemd unit").toBeGreaterThanOrEqual(0);
    expect(startIdx, "no systemctl start found").toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeLessThan(startIdx);
  });
});

describe("deploy-lib/service-reconcile — L4 Restart policy (#1278)", () => {
  const unit = readFileSync(join(scriptsDir, "abtars-watchdog.service"), "utf-8");

  it("systemd unit respawns a crashed watchdog but not an intentional stop", () => {
    // Restart=always → respawn on crash/signal death (the fix for the dead-watchdog hole).
    expect(unit).toMatch(/^Restart=always$/m);
    // RestartPreventExitStatus=2 → do NOT respawn on the intentional-stop code.
    expect(unit).toMatch(/^RestartPreventExitStatus=2$/m);
    // Guard against regressing to the narrow policies that miss crashes.
    expect(unit).not.toMatch(/^Restart=on-success$/m);
    expect(unit).not.toMatch(/^Restart=on-failure$/m);
  });

  it("RestartPreventExitStatus matches the watchdog's intentional-stop exit code", () => {
    // The policy above is only correct if the watchdog exits 2 for intentional stop
    // (abtars stop sentinel + AG5 failsafe). If the watchdog's stop exit code ever
    // changes, RestartPreventExitStatus=2 would silently start respawning a stopped
    // watchdog (or fail to). Lock the two together.
    const wd = readFileSync(join(scriptsDir, "abtars-watchdog.sh"), "utf-8");
    // `stopped) ... exit 2` — the intentional-stop path exits 2.
    expect(wd).toMatch(/stopped\)[\s\S]{0,80}?exit 2/);
    expect(unit).toMatch(/^RestartPreventExitStatus=2$/m);
  });
});

describe("deploy-lib/service-reconcile — emergency-update watchdog-liveness verify (#1278)", () => {
  const script = readFileSync(join(scriptsDir, "emergency-update.sh"), "utf-8");
  const lines = script.split("\n");

  it("verifies the watchdog is alive after respawn, before exiting", () => {
    // Must check actual liveness (watchdogPid + is-active/launchctl print), not just
    // that a restart command returned. This is the fix for the silent-swallowed-restart
    // outage — the old code masked the restart with `|| true` and never verified.
    expect(script).toContain("watchdogPid");
    expect(script).toMatch(/is-active|launchctl print/);
  });

  it("loud-fails (exit 1) when the watchdog does not come up", () => {
    // A dead watchdog after a deploy must be a hard error with a recovery hint,
    // not a swallowed no-op.
    const verifyIdx = lines.findIndex((l) => l.includes("verifying watchdog is alive"));
    const loudFailIdx = lines.findIndex(
      (l) => l.includes("NO supervisor") || (l.includes("watchdog did NOT come up")),
    );
    expect(verifyIdx, "no watchdog-liveness verify step").toBeGreaterThanOrEqual(0);
    expect(loudFailIdx, "no loud-fail on dead watchdog").toBeGreaterThanOrEqual(0);
    // The loud-fail branch must contain an explicit non-zero exit.
    const failBlock = script.slice(script.indexOf("did NOT come up"));
    expect(failBlock).toMatch(/exit 1/);
  });

  it("uses atomic systemctl restart, not the old silent stop+start on the critical path", () => {
    expect(script).toContain("systemctl --user restart abtars-watchdog");
  });
});
