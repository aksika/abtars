/**
 * #1542 — Universal skill dependency declarations: inventory, contract,
 * validation, preparation, and per-skill/strict admission behavior.
 *
 * Process tests use a generated fake `npm` binary (shell-free argv, exact
 * pins) so the suite is deterministic and network-free. Real-npm behavior
 * (local fixture registry, actual Node nested imports, deploy atomicity) is
 * covered by src/tests/e2e/skill-dependency-deploy.e2e.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverSkillCandidates,
  sourceOfSkill,
  resolveShadowedCandidates,
  readSkillDependencies,
  validateAndAggregate,
  isValidPackageName,
  isValidExactVersion,
  directInstalledVersion,
  npmInstallArgv,
  recoveryCommand,
  installNpmPackages,
  probeNestedResolution,
  prepareSkillDependencies,
  prepareDeploySkillDependencies,
  SkillDependencyError,
  type SkillCandidate,
} from "./skill-dependencies.js";

const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.FAKE_NPM_LOG) {
  fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
}
const prefixIdx = args.indexOf("--prefix");
const prefix = prefixIdx >= 0 ? args[prefixIdx + 1] : process.cwd();
const pins = args.filter(a => !a.startsWith("-"));
if (process.env.FAKE_NPM_FAIL === "1") { console.error("fake npm: forced failure"); process.exit(1); }
const sleep = Number(process.env.FAKE_NPM_SLEEP_MS ?? 0);
if (sleep > 0) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleep); }
for (const pin of pins) {
  const at = pin.lastIndexOf("@");
  const name = pin.slice(0, at);
  const version = pin.slice(at + 1);
  const version2 = process.env.FAKE_NPM_WRONG_VERSION === "1" ? "0.0.0-wrong" : version;
  const dir = path.join(prefix, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: version2, type: "module", exports: { ".": "./index.js" } }));
  fs.writeFileSync(path.join(dir, "index.js"), "export const VALUE = 1;\\n");
  if (process.env.FAKE_NPM_NO_ENTRY === "1") {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: version2 }));
    fs.rmSync(path.join(dir, "index.js"));
  }
  console.log("fake npm: installed " + name + "@" + version2);
}
`;

describe("#1542 — skill dependency inventory", () => {
  let home: string;
  let root: string; // runtime skills root = <home>/skills (walk-up resolution parity)
  let fakeNpm: string;

  function skill(group: string, name: string, deps: Record<string, string> | null): string {
    const dir = join(root, group, name);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture skill\n---\n`);
    if (deps !== null) {
      writeFileSync(join(dir, "scripts", "package.json"), JSON.stringify({ type: "module", dependencies: deps }, null, 2));
    }
    return dir;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "skill-deps-home-"));
    root = join(home, "skills");
    mkdirSync(root, { recursive: true });
    fakeNpm = join(home, "fake-npm");
    writeFileSync(fakeNpm, FAKE_NPM);
    chmodSync(fakeNpm, 0o755);
    process.env.ABTARS_SKILL_NPM_BIN = fakeNpm;
  });

  afterEach(() => {
    delete process.env.FAKE_NPM_LOG;
    delete process.env.FAKE_NPM_FAIL;
    delete process.env.FAKE_NPM_SLEEP_MS;
    delete process.env.FAKE_NPM_WRONG_VERSION;
    delete process.env.FAKE_NPM_NO_ENTRY;
    delete process.env.ABTARS_SKILL_NPM_BIN;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // ── Discovery ─────────────────────────────────────────────────────────

  it("discovers skills from every supported source group", () => {
    for (const group of ["core", "self", "custom", "downloaded"]) skill(group, `${group}-skill`, null);
    const found = discoverSkillCandidates(root);
    expect(found.map(c => `${c.source}:${c.name}`).sort()).toEqual([
      "core:core-skill",
      "custom:custom-skill",
      "downloaded:downloaded-skill",
      "self:self-skill",
    ]);
  });

  it("ignores directories without SKILL.md", () => {
    skill("core", "real-skill", null);
    mkdirSync(join(root, "core", "no-skill", "scripts"), { recursive: true });
    writeFileSync(join(root, "core", "no-skill", "scripts", "package.json"), JSON.stringify({ dependencies: { a: "1.0.0" } }));
    const found = discoverSkillCandidates(root);
    expect(found.map(c => c.name)).toEqual(["real-skill"]);
  });

  it("does not traverse outside the approved root through symlinks", () => {
    skill("self", "inner", null);
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    mkdirSync(join(outside, "escape-skill", "scripts"), { recursive: true });
    writeFileSync(join(outside, "escape-skill", "SKILL.md"), "# escape\n");
    symlinkSync(join(outside, "escape-skill"), join(root, "self", "escape-skill"));
    const found = discoverSkillCandidates(root);
    expect(found.map(c => c.name).sort()).toEqual(["inner"]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("ignores a SKILL.md symlink that points outside the approved root", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-skill-md-"));
    writeFileSync(join(outside, "SKILL.md"), "# escaped\n");
    const dir = join(root, "self", "escaped-file");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(outside, "SKILL.md"), join(dir, "SKILL.md"));

    expect(discoverSkillCandidates(root).map(c => c.name)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("reports a package manifest symlink that points outside the approved root", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-manifest-"));
    writeFileSync(join(outside, "package.json"), JSON.stringify({ dependencies: { "escaped-pkg": "1.0.0" } }));
    const dir = skill("self", "unsafe-manifest", null);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    symlinkSync(join(outside, "package.json"), join(dir, "scripts", "package.json"));

    const candidate = discoverSkillCandidates(root).find(c => c.name === "unsafe-manifest");
    expect(candidate?.manifestError).toContain("escapes");
    expect(candidate && readSkillDependencies(candidate)).toEqual({ ok: false, error: candidate?.manifestError });
    rmSync(outside, { recursive: true, force: true });
  });

  it("reports a missing root as an empty inventory", () => {
    expect(discoverSkillCandidates(join(root, "nope"))).toEqual([]);
  });

  it("maps the source group from the first path segment", () => {
    expect(sourceOfSkill(root, join(root, "custom", "thing"))).toBe("custom");
    expect(sourceOfSkill(root, join(root, "unknown-dir", "thing"))).toBe("unknown-dir");
    expect(sourceOfSkill(root, root)).toBe("core");
  });

  it("keeps the highest-precedence candidate for shadowed identities", () => {
    skill("self", "dup", null);
    skill("custom", "dup", null);
    skill("core", "dup", null);
    const best = resolveShadowedCandidates(discoverSkillCandidates(root));
    expect(best).toHaveLength(1);
    expect(best[0]!.source).toBe("self");
  });

  // ── Declaration contract ──────────────────────────────────────────────

  it("treats absent/empty declarations as zero dependencies", () => {
    const noManifest = skill("core", "plain", null);
    const empty = skill("core", "empty", {});
    expect(readSkillDependencies({ name: "plain", source: "core", rootDir: noManifest })).toEqual({ ok: true, declarations: [] });
    const emptyCand = { name: "empty", source: "core", rootDir: empty, manifestPath: join(empty, "scripts", "package.json") };
    expect(readSkillDependencies(emptyCand)).toEqual({ ok: true, declarations: [] });
  });

  it("parses exact declarations from a manifest", () => {
    const dir = skill("self", "declaring", { "example-runtime-package": "1.2.3" });
    const cand = { name: "declaring", source: "self", rootDir: dir, manifestPath: join(dir, "scripts", "package.json") };
    const read = readSkillDependencies(cand);
    expect(read.ok && read.declarations).toEqual([{ skill: cand, packageName: "example-runtime-package", version: "1.2.3" }]);
  });

  it("rejects malformed manifests", () => {
    const dir = join(root, "core", "broken");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# broken\n");
    writeFileSync(join(dir, "scripts", "package.json"), "{ not json");
    const cand = { name: "broken", source: "core", rootDir: dir, manifestPath: join(dir, "scripts", "package.json") };
    const read = readSkillDependencies(cand);
    expect(read.ok).toBe(false);
  });

  it("validates package names and exact versions", () => {
    expect(isValidPackageName("rettiwt-api")).toBe(true);
    expect(isValidPackageName("@scope/package")).toBe(true);
    expect(isValidPackageName("Uppercase")).toBe(false);
    expect(isValidPackageName(".hidden")).toBe(false);
    expect(isValidPackageName("has space")).toBe(false);
    expect(isValidPackageName("@scope/")).toBe(false);
    expect(isValidExactVersion("1.2.3")).toBe(true);
    expect(isValidExactVersion("1.2.3-beta.1")).toBe(true);
    expect(isValidExactVersion("1.2.3+build.5")).toBe(true);
    expect(isValidExactVersion("0.0.0")).toBe(true);
    expect(isValidExactVersion("01.2.3")).toBe(false);
    expect(isValidExactVersion("1.2.3-")).toBe(false);
    expect(isValidExactVersion("1.2.3+")).toBe(false);
    expect(isValidExactVersion("1.2.3-01")).toBe(false);
    expect(isValidExactVersion("^1.2.3")).toBe(false);
    expect(isValidExactVersion("~1.2.3")).toBe(false);
    expect(isValidExactVersion("1.2.x")).toBe(false);
    expect(isValidExactVersion(">=1.2.3")).toBe(false);
    expect(isValidExactVersion("1.2.3 || 2.0.0")).toBe(false);
    expect(isValidExactVersion("v1.2.3")).toBe(false);
    expect(isValidExactVersion("latest")).toBe(false);
    expect(isValidExactVersion("npm:other@1.0.0")).toBe(false);
    expect(isValidExactVersion("file:../pkg")).toBe(false);
    expect(isValidExactVersion("git+https://github.com/a/b.git")).toBe(false);
    expect(isValidExactVersion("1.2")).toBe(false);
    expect(isValidExactVersion("$VAR")).toBe(false);
  });

  it("deduplicates identical pins and aggregates deterministically", () => {
    const a = skill("core", "a", { "pkg-a": "1.0.0", "pkg-b": "2.0.0" });
    const b = skill("self", "b", { "pkg-a": "1.0.0" });
    const ca: SkillCandidate = { name: "a", source: "core", rootDir: a };
    const cb: SkillCandidate = { name: "b", source: "self", rootDir: b };
    const result = validateAndAggregate([
      { skill: ca, packageName: "pkg-a", version: "1.0.0" },
      { skill: ca, packageName: "pkg-b", version: "2.0.0" },
      { skill: cb, packageName: "pkg-a", version: "1.0.0" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.packages.get("pkg-a")).toBe("1.0.0");
    expect(result.plan.packages.size).toBe(2);
    expect(result.plan.declarations).toHaveLength(2); // pkg-a deduped
    expect(result.plan.declarations.map(d => d.packageName)).toEqual(["pkg-a", "pkg-b"]);
  });

  it("rejects cross-skill conflicting exact versions with all affected skills", () => {
    const a = skill("core", "a", { "pkg-a": "1.0.0" });
    const b = skill("downloaded", "b", { "pkg-a": "2.0.0" });
    const result = validateAndAggregate([
      { skill: { name: "a", source: "core", rootDir: a }, packageName: "pkg-a", version: "1.0.0" },
      { skill: { name: "b", source: "downloaded", rootDir: b }, packageName: "pkg-a", version: "2.0.0" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toContain("conflicting exact versions");
    expect(result.errors[0]!.message).toContain("pkg-a");
    expect(result.errors[0]!.message).toContain("a [core]");
    expect(result.errors[0]!.message).toContain("b [downloaded]");
    expect(result.errors[0]!.skills.map(s => s.name).sort()).toEqual(["a", "b"]);
  });

  // ── Preparation (fake npm) ────────────────────────────────────────────

  async function prepareWith(candidates: SkillCandidate[], mode: "strict" | "per-skill") {
    return prepareSkillDependencies(candidates, { mode, home, npmBin: fakeNpm });
  }

  it("installs a missing exact dependency and reports it", async () => {
    const dir = skill("core", "needs-pkg", { "fixture-pkg": "1.2.3" });
    const cand = { name: "needs-pkg", source: "core", rootDir: dir, manifestPath: join(dir, "scripts", "package.json") };
    const result = await prepareWith([cand], "per-skill");
    expect(result.ready.map(c => c.name)).toEqual(["needs-pkg"]);
    expect(result.skipped).toEqual([]);
    expect(result.installed).toEqual([{ name: "fixture-pkg", version: "1.2.3" }]);
    expect(directInstalledVersion(home, "fixture-pkg")).toBe("1.2.3");
  });

  it("does not invoke the installer when exact versions already match", async () => {
    const log = join(root, "npm.log");
    process.env.FAKE_NPM_LOG = log;
    const dir = skill("core", "needs-pkg", { "fixture-pkg": "1.2.3" });
    const cand = { name: "needs-pkg", source: "core", rootDir: dir, manifestPath: join(dir, "scripts", "package.json") };
    await prepareWith([cand], "per-skill");
    const first = readFileSync(log, "utf-8");
    await prepareWith([cand], "per-skill");
    expect(readFileSync(log, "utf-8")).toBe(first); // second prep = no-op
    expect(first).toContain("fixture-pkg@1.2.3");
  });

  it("repairs a drifted direct version to the exact declared pin", async () => {
    const log = join(root, "npm.log");
    process.env.FAKE_NPM_LOG = log;
    mkdirSync(join(home, "node_modules", "fixture-pkg"), { recursive: true });
    writeFileSync(join(home, "node_modules", "fixture-pkg", "package.json"), JSON.stringify({ name: "fixture-pkg", version: "9.9.9" }));
    const dir = skill("core", "needs-pkg", { "fixture-pkg": "1.2.3" });
    const cand = { name: "needs-pkg", source: "core", rootDir: dir, manifestPath: join(dir, "scripts", "package.json") };
    const result = await prepareWith([cand], "per-skill");
    expect(result.ready.map(c => c.name)).toEqual(["needs-pkg"]);
    expect(directInstalledVersion(home, "fixture-pkg")).toBe("1.2.3");
    expect(readFileSync(log, "utf-8")).toContain("fixture-pkg@1.2.3");
  });

  it("skips only the affected skill when npm fails (per-skill mode)", async () => {
    process.env.FAKE_NPM_FAIL = "1";
    const a = skill("core", "bad", { "fixture-pkg": "1.2.3" });
    const b = skill("self", "fine", {});
    const ca = { name: "bad", source: "core", rootDir: a, manifestPath: join(a, "scripts", "package.json") };
    const cb = { name: "fine", source: "self", rootDir: b };
    const result = await prepareWith([ca, cb], "per-skill");
    expect(result.ready.map(c => c.name)).toEqual(["fine"]);
    expect(result.skipped.map(s => s.skill.name)).toEqual(["bad"]);
    expect(result.skipped[0]!.reasons[0]).toContain("npm install failed");
    expect(result.skipped[0]!.reasons[0]).toContain("npm install --prefix");
    expect(result.skipped[0]!.reasons[0]).toContain("fixture-pkg@1.2.3");
  });

  it("still prepares unaffected skills when another declaration is invalid", async () => {
    const bad = skill("downloaded", "bad", { "bad-pkg": "^1.2.3" });
    const good = skill("self", "good", { "fixture-pkg": "1.2.3" });
    const badCandidate = { name: "bad", source: "downloaded", rootDir: bad, manifestPath: join(bad, "scripts", "package.json") };
    const goodCandidate = { name: "good", source: "self", rootDir: good, manifestPath: join(good, "scripts", "package.json") };

    const result = await prepareWith([badCandidate, goodCandidate], "per-skill");

    expect(result.ready.map(c => c.name)).toEqual(["good"]);
    expect(result.skipped.map(s => s.skill.name)).toEqual(["bad"]);
    expect(result.installed).toEqual([{ name: "fixture-pkg", version: "1.2.3" }]);
    expect(directInstalledVersion(home, "fixture-pkg")).toBe("1.2.3");
  });

  it("excludes every owner when a deduplicated shared pin cannot be installed", async () => {
    process.env.FAKE_NPM_FAIL = "1";
    const first = skill("self", "first", { "fixture-pkg": "1.2.3" });
    const second = skill("custom", "second", { "fixture-pkg": "1.2.3" });
    const firstCandidate = { name: "first", source: "self", rootDir: first, manifestPath: join(first, "scripts", "package.json") };
    const secondCandidate = { name: "second", source: "custom", rootDir: second, manifestPath: join(second, "scripts", "package.json") };

    const result = await prepareWith([firstCandidate, secondCandidate], "per-skill");

    expect(result.ready).toEqual([]);
    expect(result.skipped.map(s => s.skill.name).sort()).toEqual(["first", "second"]);
  });

  it("throws before any process mutation in strict mode on install failure", async () => {
    process.env.FAKE_NPM_FAIL = "1";
    const a = skill("core", "bad", { "fixture-pkg": "1.2.3" });
    const ca = { name: "bad", source: "core", rootDir: a, manifestPath: join(a, "scripts", "package.json") };
    await expect(prepareWith([ca], "strict")).rejects.toThrow(SkillDependencyError);
    expect(existsSync(join(home, "node_modules"))).toBe(false);
  });

  it("times out a hung installer and reports failure", async () => {
    process.env.FAKE_NPM_SLEEP_MS = "20000";
    const slow = await installNpmPackages(home, [{ name: "fixture-pkg", version: "1.2.3" }], { npmBin: fakeNpm, timeoutMs: 500 });
    expect(slow.ok).toBe(false);
    expect(existsSync(join(home, "node_modules"))).toBe(false);
  });

  it("detects a post-install mismatch when npm exits 0 with a wrong version", async () => {
    process.env.FAKE_NPM_WRONG_VERSION = "1";
    const a = skill("core", "mismatch", { "fixture-pkg": "1.2.3" });
    const ca = { name: "mismatch", source: "core", rootDir: a, manifestPath: join(a, "scripts", "package.json") };
    const result = await prepareWith([ca], "per-skill");
    expect(result.ready).toEqual([]);
    expect(result.skipped[0]!.reasons[0]).toContain("post-install verification failed");
  });

  it("rejects invalid declarations before running npm (strict throws)", async () => {
    const a = skill("core", "bad-ver", { "fixture-pkg": "^1.2.3" });
    const ca = { name: "bad-ver", source: "core", rootDir: a, manifestPath: join(a, "scripts", "package.json") };
    await expect(prepareWith([ca], "strict")).rejects.toThrow(/not an exact/);
    expect(existsSync(join(home, "node_modules"))).toBe(false);
  });

  it("excludes conflicting skills and keeps unaffected ones (per-skill mode)", async () => {
    const a = skill("core", "v1", { "fixture-pkg": "1.0.0" });
    const b = skill("self", "v2", { "fixture-pkg": "2.0.0" });
    const c = skill("custom", "none", {});
    const ca = { name: "v1", source: "core", rootDir: a, manifestPath: join(a, "scripts", "package.json") };
    const cb = { name: "v2", source: "self", rootDir: b, manifestPath: join(b, "scripts", "package.json") };
    const cc = { name: "none", source: "custom", rootDir: c };
    const result = await prepareWith([ca, cb, cc], "per-skill");
    expect(result.ready.map(x => x.name)).toEqual(["none"]);
    expect(result.skipped.map(s => s.skill.name).sort()).toEqual(["v1", "v2"]);
    expect(existsSync(join(home, "node_modules"))).toBe(false); // conflict rejected before npm
  });

  // ── Nested resolution ─────────────────────────────────────────────────

  it("probes real Node resolution from a nested skill script path", async () => {
    const dir = skill("downloaded", "nested", { "fixture-pkg": "1.2.3" });
    // Install a real module so Node can resolve it.
    mkdirSync(join(home, "node_modules", "fixture-pkg"), { recursive: true });
    writeFileSync(join(home, "node_modules", "fixture-pkg", "package.json"), JSON.stringify({
      name: "fixture-pkg",
      version: "1.2.3",
      type: "module",
      exports: { ".": "./index.js" },
    }));
    writeFileSync(join(home, "node_modules", "fixture-pkg", "index.js"), "export const VALUE = 42;\n");
    const cand = { name: "nested", source: "downloaded", rootDir: dir };
    expect(probeNestedResolution(cand, "fixture-pkg")).toBe(true);
    expect(probeNestedResolution(cand, "fixture-absent")).toBe(false);
  });

  it("excludes a skill whose declared package fails nested resolution", async () => {
    process.env.FAKE_NPM_NO_ENTRY = "1";
    const a = skill("self", "unresolvable", { "fixture-pkg": "1.2.3" });
    const ca = { name: "unresolvable", source: "self", rootDir: a, manifestPath: join(a, "scripts", "package.json") };
    // Fake npm installs the exact version, but the fixture has no importable
    // entry — the real nested resolution probe fails and the skill is excluded.
    const result = await prepareWith([ca], "per-skill");
    expect(result.skipped.map(s => s.skill.name)).toEqual(["unresolvable"]);
    expect(result.skipped[0]!.reasons[0]).toContain("nested module resolution failed");
  });

  // ── npm argv construction ─────────────────────────────────────────────

  it("builds a single shell-free bounded npm argv", () => {
    const argv = npmInstallArgv(home, [{ name: "fixture-pkg", version: "1.2.3" }], { registryUrl: "http://127.0.0.1:9" });
    expect(argv).toEqual([
      "install",
      "--prefix",
      home,
      "--no-save",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      "--registry",
      "http://127.0.0.1:9",
      "fixture-pkg@1.2.3",
    ]);
    expect(recoveryCommand(home, [{ name: "fixture-pkg", version: "1.2.3" }])).toContain("--prefix " + home);
    expect(recoveryCommand(home, [{ name: "fixture-pkg", version: "1.2.3" }])).toContain("fixture-pkg@1.2.3");
  });

  it("passes the exact argv to npm", async () => {
    const log = join(root, "npm.log");
    process.env.FAKE_NPM_LOG = log;
    const a = skill("core", "argv-check", { "fixture-pkg": "1.2.3" });
    const ca = { name: "argv-check", source: "core", rootDir: a, manifestPath: join(a, "scripts", "package.json") };
    await prepareWith([ca], "per-skill");
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const argv = JSON.parse(lines[0]!) as string[];
    expect(argv[0]).toBe("install");
    expect(argv).toContain("fixture-pkg@1.2.3");
    expect(argv).toContain("--prefix");
  });

  // ── Deploy composition ────────────────────────────────────────────────

  it("composes staged core + preserved user skills for deploy, excluding runtime core", async () => {
    const staged = join(home, "staged", "templates");
    const stagedCore = join(staged, "skills");
    mkdirSync(join(stagedCore, "new-core-skill", "scripts"), { recursive: true });
    writeFileSync(join(stagedCore, "new-core-skill", "SKILL.md"), "# new-core-skill\n");
    writeFileSync(join(stagedCore, "new-core-skill", "scripts", "package.json"), JSON.stringify({ dependencies: { "fixture-pkg": "1.2.3" } }));
    // Runtime tree: old core (superseded) + user-owned groups.
    skill("core", "old-core", { "fixture-pkg": "9.0.0" });
    skill("self", "user-skill", { "fixture-pkg": "1.2.3" });
    const result = await prepareDeploySkillDependencies(staged, home);
    expect(result.installed).toEqual([{ name: "fixture-pkg", version: "1.2.3" }]);
    expect(directInstalledVersion(home, "fixture-pkg")).toBe("1.2.3");
  });
});
