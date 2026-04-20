/**
 * Regression test for #221 Stage A — bootstrap env module.
 *
 * Contract: importing `boot/env.js` loads `$AGENT_BRIDGE_HOME/.env` into
 * process.env as a side effect of module evaluation. main.ts imports it
 * FIRST so subsequent static imports (hoisted above main.ts body) see the
 * populated env at their own module-level read time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_KEY = "__BOOT_ENV_TEST_KEY";
const SKILLS_KEY = "__BOOT_ENV_SKILLS_KEY";

describe("boot/env — bootstrap populates process.env from .env", () => {
  let tmpDir: string;
  const savedHome = process.env["AGENT_BRIDGE_HOME"];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "boot-env-"));
    mkdirSync(join(tmpDir, "config"), { recursive: true });
    writeFileSync(join(tmpDir, ".env"), `${TEST_KEY}=from-dotenv\n`);
    writeFileSync(join(tmpDir, "config", ".env.skills"), `${SKILLS_KEY}=from-skills\n`);
    process.env["AGENT_BRIDGE_HOME"] = tmpDir;
    delete process.env[TEST_KEY];
    delete process.env[SKILLS_KEY];
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env["AGENT_BRIDGE_HOME"];
    else process.env["AGENT_BRIDGE_HOME"] = savedHome;
    delete process.env[TEST_KEY];
    delete process.env[SKILLS_KEY];
  });

  it("populates process.env from $AGENT_BRIDGE_HOME/.env on import", async () => {
    expect(process.env[TEST_KEY]).toBeUndefined();
    await import("./env.js");
    expect(process.env[TEST_KEY]).toBe("from-dotenv");
  });

  it("also populates from $AGENT_BRIDGE_HOME/config/.env.skills", async () => {
    expect(process.env[SKILLS_KEY]).toBeUndefined();
    await import("./env.js");
    expect(process.env[SKILLS_KEY]).toBe("from-skills");
  });

  it("does not override values already in process.env (override: false)", async () => {
    process.env[TEST_KEY] = "from-process";
    await import("./env.js");
    expect(process.env[TEST_KEY]).toBe("from-process");
  });
});
