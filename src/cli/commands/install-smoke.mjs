#!/usr/bin/env node
/**
 * Install smoke test — run standalone: node src/cli/commands/install-smoke.mjs
 * Verifies abtars install works in a temp dir. Exit 0=pass, 1=fail.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = new URL("../../../bundle/abtars-cli.js", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "abtars-smoke-"));
let failed = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ ${msg}`); failed++; }
  else console.log(`  ✓ ${msg}`);
}

// Test: install
const r = spawnSync("node", [CLI, "install", "--mode=simple", "--force"], {
  env: { ...process.env, ABTARS_HOME: home, ABMIND_HOME: join(home, ".abmind") },
  encoding: "utf-8",
  timeout: 30_000,
});
const out = (r.stdout || "") + (r.stderr || "");

assert(out.includes("skeleton at"), "install prints skeleton");
assert(out.includes("install mode: simple"), "install prints mode");
assert(existsSync(join(home, "manifest.json")), "manifest.json created");
assert(existsSync(join(home, "config")), "config/ created");
assert(existsSync(join(home, "bin")), "bin/ created");
assert(existsSync(join(home, "logs")), "logs/ created");

if (existsSync(join(home, "manifest.json"))) {
  const m = JSON.parse(readFileSync(join(home, "manifest.json"), "utf-8"));
  assert(m.installMode === "simple", "installMode=simple in manifest");
  assert(m.package === "abtars", "package=abtars in manifest");
}

// Test: --help
const h = spawnSync("node", [CLI, "--help"], { encoding: "utf-8", timeout: 5000 });
assert(h.stdout.includes("abtars"), "--help contains abtars");
assert(h.stdout.includes("install"), "--help contains install");

// Cleanup
rmSync(home, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "✅" : "❌"} install-smoke: ${failed === 0 ? "PASS" : `${failed} FAILED`}`);
process.exit(failed > 0 ? 1 : 0);
