import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isolatedChildEnv } from "../test-support/runtime-isolation.js";

const TEST_HOME = "/tmp/abtars-secret-test-" + process.pid;
const CONFIG_DIR = join(TEST_HOME, "config");
const SECRET_DIR = join(TEST_HOME, "secret");
const CWD = join(__dirname, "../..");

describe("boot/env.ts — secret file loading", () => {
  beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(CONFIG_DIR, ".env"), "");
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  function run(): { stdout: string; stderr: string } {
    const hasDist = existsSync(join(CWD, "dist", "boot", "env.js"));
    const args = hasDist
      ? ["--import", "./dist/boot/env.js"]
      : ["--import", "tsx/esm", "--import", "./src/boot/env.ts"];
    const r = spawnSync("node", [
      ...args,
      "-e", `console.log(JSON.stringify({ MY_KEY: process.env.MY_KEY || null }))`,
    ], {
      encoding: "utf-8",
      env: isolatedChildEnv({ ABTARS_HOME: TEST_HOME }),
      timeout: 5000,
      cwd: CWD,
    });
    return { stdout: r.stdout, stderr: r.stderr };
  }

  it("loads secret file into process.env", () => {
    writeFileSync(join(SECRET_DIR, "MY_KEY"), "super-secret-value\n");
    const { stdout } = run();
    expect(JSON.parse(stdout.trim())).toEqual({ MY_KEY: "super-secret-value" });
  });

  it("skips missing secret files silently", () => {
    // No MY_KEY file in secret dir
    const { stdout, stderr } = run();
    expect(JSON.parse(stdout.trim())).toEqual({ MY_KEY: null });
    expect(stderr).not.toContain("Error");
  });

  it("skips empty secret files", () => {
    writeFileSync(join(SECRET_DIR, "MY_KEY"), "   \n");
    const { stdout } = run();
    expect(JSON.parse(stdout.trim())).toEqual({ MY_KEY: null });
  });

  it("does not touch env vars with normal values in .env", () => {
    writeFileSync(join(CONFIG_DIR, ".env"), "MY_KEY=normal-value\n");
    const { stdout } = run();
    // Secret dir takes precedence if file exists, otherwise .env value stays
    expect(JSON.parse(stdout.trim())).toEqual({ MY_KEY: "normal-value" });
  });
});
