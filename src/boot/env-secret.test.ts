import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const TEST_HOME = "/tmp/abtars-secret-test-" + process.pid;
const CONFIG_DIR = join(TEST_HOME, "config");
const SECRET_DIR = join(TEST_HOME, "secret");
const CWD = join(__dirname, "../..");

describe("boot/env.ts — <secret> resolution", () => {
  beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  function run(envContent: string): { stdout: string; stderr: string } {
    writeFileSync(join(CONFIG_DIR, ".env"), envContent);
    const r = spawnSync("node", [
      "--import", "./dist/boot/env.js",
      "-e", `console.log(JSON.stringify({ MY_KEY: process.env.MY_KEY || null }))`,
    ], {
      encoding: "utf-8",
      env: { ...process.env, ABTARS_HOME: TEST_HOME },
      timeout: 5000,
      cwd: CWD,
    });
    return { stdout: r.stdout, stderr: r.stderr };
  }

  it("resolves <secret> when file exists", () => {
    writeFileSync(join(SECRET_DIR, "MY_KEY"), "super-secret-value\n");
    const { stdout } = run("MY_KEY=<secret>\n");
    expect(JSON.parse(stdout.trim())).toEqual({ MY_KEY: "super-secret-value" });
  });

  it("logs BOOT ERROR when secret file is missing", () => {
    const { stderr } = run("MY_KEY=<secret>\n");
    expect(stderr).toContain("[BOOT ERROR]");
    expect(stderr).toContain("MY_KEY");
    expect(stderr).toContain("does not exist");
  });

  it("logs BOOT ERROR when secret file is empty", () => {
    writeFileSync(join(SECRET_DIR, "MY_KEY"), "   \n");
    const { stderr } = run("MY_KEY=<secret>\n");
    expect(stderr).toContain("[BOOT ERROR]");
    expect(stderr).toContain("empty");
  });

  it("does not touch env vars with normal values", () => {
    const { stdout } = run("MY_KEY=normal-value\n");
    expect(JSON.parse(stdout.trim())).toEqual({ MY_KEY: "normal-value" });
  });
});
