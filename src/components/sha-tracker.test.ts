import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("sha-tracker", () => {
  let tempHome: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "sha-test-"));
    mkdirSync(join(tempHome, "config"), { recursive: true });
    mkdirSync(join(tempHome, "state"), { recursive: true });
    originalEnv = process.env["ABTARS_HOME"];
    process.env["ABTARS_HOME"] = tempHome;
    writeFileSync(join(tempHome, "config", "sha-policy.json"), JSON.stringify({
      faults: {
        "missing-dep": { action: "disable-capability", cooldown: 60, maxRetries: 1 },
        "irc-flap": { action: "disable-capability", cooldown: 10, maxRetries: 3 },
      }
    }));
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env["ABTARS_HOME"] = originalEnv;
    else delete process.env["ABTARS_HOME"];
    rmSync(tempHome, { recursive: true, force: true });
  });

  async function getTracker() {
    // Force fresh import to pick up new ABTARS_HOME
    const mod = await import("../components/sha-tracker.js");
    mod.reload();
    return mod;
  }

  it("returns true when no state (fresh)", async () => {
    const { shouldAttempt } = await getTracker();
    expect(shouldAttempt("missing-dep", "browser")).toBe(true);
  });

  it("returns false after maxRetries within cooldown", async () => {
    const { shouldAttempt, recordResult } = await getTracker();
    recordResult("missing-dep", "browser", false, "not found");
    expect(shouldAttempt("missing-dep", "browser")).toBe(false);
  });

  it("returns true after cooldown expires", async () => {
    const { shouldAttempt, recordResult } = await getTracker();
    recordResult("missing-dep", "browser", false, "not found");
    // Manually backdate the state
    const statePath = join(tempHome, "state", "sha-state.json");
    const state = JSON.parse(require("fs").readFileSync(statePath, "utf-8"));
    state["missing-dep:browser"].lastAttempt = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(statePath, JSON.stringify(state));
    expect(shouldAttempt("missing-dep", "browser")).toBe(true);
  });

  it("resets attempts on success", async () => {
    const { shouldAttempt, recordResult } = await getTracker();
    recordResult("irc-flap", "default", false, "timeout");
    recordResult("irc-flap", "default", false, "timeout");
    recordResult("irc-flap", "default", true); // success
    expect(shouldAttempt("irc-flap", "default")).toBe(true);
  });

  it("returns false when policy file missing (circuit breaker)", async () => {
    rmSync(join(tempHome, "config", "sha-policy.json"));
    const { shouldAttempt, reload } = await getTracker();
    reload();
    expect(shouldAttempt("missing-dep", "browser")).toBe(false);
  });
});
