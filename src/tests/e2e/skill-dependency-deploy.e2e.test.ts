/**
 * Epic 23 final E2E (#1542) — skill dependency declaration + deploy-time install.
 *
 * A full staged-release journey against a LOCAL fixture npm registry:
 *   fresh install → activate → reconcile → real nested ESM import,
 *   idempotent repeat (no npm), drift repair, and failure atomicity.
 * No external network: every package and packument comes from a loopback
 * HTTP server backed by locally npm-packed fixture tarballs.
 *
 * Run directly:
 *   npx vitest run src/tests/e2e/skill-dependency-deploy.e2e.test.ts
 * Included in `npm run test:e2e`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync, readlinkSync,
} from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { deployActivation } from "../../cli/deploy-lib/deploy.js";
import { healthProbe } from "../../cli/deploy-lib/releases.js";
import type { StagedRelease } from "../../cli/update-sources/types.js";

const TIMEOUT = 180_000;

// ── Local fixture registry ────────────────────────────────────────────────

interface RegistryPackage {
  name: string;
  /** version -> tarball path */
  versions: Map<string, string>;
}

function npmAvailable(): boolean {
  const r = spawnSync("npm", ["--version"], { stdio: "ignore", timeout: 15_000 });
  return !r.error && r.status === 0;
}

/** Local static npm registry serving packuments + tarballs on loopback. */
async function startRegistry(packages: RegistryPackage[]): Promise<{
  url: string;
  close: () => void;
  hits: () => string[];
}> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    for (const pkg of packages) {
      if (path === `/${pkg.name}`) {
        hits.push(`packument:${pkg.name}`);
        const packument: Record<string, unknown> = {
          name: pkg.name,
          "dist-tags": { latest: [...pkg.versions.keys()].sort().at(-1) },
          versions: {},
        };
        const versions = packument["versions"] as Record<string, unknown>;
        const addr = server.address();
        if (addr === null || typeof addr === "string") throw new Error("registry not listening on a TCP port");
        for (const [version, tarball] of pkg.versions) {
          const data = readFileSync(tarball);
          const sha1 = createHash("sha1").update(data).digest("hex");
          versions[version] = {
            name: pkg.name,
            version,
            dist: {
              tarball: `http://127.0.0.1:${addr.port}/${pkg.name}/-/${pkg.name}-${version}.tgz`,
              shasum: sha1,
            },
          };
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(packument));
        return;
      }
      const tarballMatch = path.match(/^\/[^/]+\/-\/(.+)\.tgz$/);
      if (tarballMatch) {
        const fileNameRaw = tarballMatch[1];
        if (fileNameRaw !== undefined) {
          const fileName = `${fileNameRaw}.tgz`;
          const version = fileNameRaw.replace(`${pkg.name}-`, "");
          const tarball = pkg.versions.get(version);
          if (tarball && basename(tarball) === fileName) {
            hits.push(`tarball:${pkg.name}@${version}`);
            res.setHeader("content-type", "application/octet-stream");
            res.end(readFileSync(tarball));
            return;
          }
        }
      }
    }
    res.statusCode = 404;
    res.end("not found: " + path);
  });
  return await new Promise<{ url: string; close: () => void; hits: () => string[] }>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("registry not listening on a TCP port");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        hits: () => [...hits],
      });
    });
  });
}

/** npm-pack a neutral fixture package directory into a tarball. */
function packFixture(dir: string): string {
  const r = spawnSync("npm", ["pack", "--pack-destination", dir], { cwd: dir, stdio: "pipe", timeout: 30_000 });
  if (r.error || r.status !== 0) throw new Error(`npm pack failed: ${r.stderr?.toString() || r.stdout?.toString()}`);
  const name = r.stdout.toString().trim().split("\n").at(-1) ?? "";
  return join(dir, name);
}

/** Real npm binary wrapper recording exact argv (pass-through). */
function writeNpmWrapper(path: string, log: string): void {
  writeFileSync(path, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const r = spawnSync("npm", process.argv.slice(2), { stdio: "inherit" });
process.exit(r.status ?? 1);
`);
  chmodSync(path, 0o755);
}

// ── Fixture staged release ───────────────────────────────────────────────

interface StagedFixture {
  stagedPath: string;
  releaseDir: string;
  skillDir: string;
  writeDeclaredVersion: (version: string) => void;
}

function writeFixturePackage(root: string, name: string, version: string): string {
  const dir = join(root, "fixtures", `${name}-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name,
    version,
    type: "module",
    exports: { ".": "./index.js" },
  }, null, 2));
  writeFileSync(join(dir, "index.js"), `export const VALUE = "${name}-${version}";\n`);
  return packFixture(dir);
}

/** Create a staged release whose core skill declares fixture-pkg@<version>. */
function makeStagedRelease(stagedRoot: string, version: string): StagedFixture {
  const stagedPath = join(stagedRoot, "staged");
  mkdirSync(join(stagedPath, "bundle"), { recursive: true });
  writeFileSync(join(stagedPath, "bundle", "abtars.js"), "// mock entry point");
  writeFileSync(join(stagedPath, "install-manifest.json"), JSON.stringify({
    cliWrappers: [],
    directories: [],
    configSeeds: [],
    manifestVersion: 1,
    lazyRoots: [],
  }));
  const skillDir = join(stagedPath, "templates", "skills", "fixture-skill");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---
name: fixture-skill
description: Neutral E2E fixture skill
---
# Fixture Skill
`);
  const manifestPath = join(skillDir, "scripts", "package.json");
  const writeDeclaredVersion = (v: string): void => {
    writeFileSync(manifestPath, JSON.stringify({ type: "module", dependencies: { "fixture-pkg": v } }, null, 2));
  };
  writeDeclaredVersion(version);
  return {
    stagedPath,
    releaseDir: join(stagedRoot, "releases", "e2e-commit"),
    skillDir,
    writeDeclaredVersion,
  };
}

// ── The journey ──────────────────────────────────────────────────────────

describe.skipIf(!npmAvailable())("Epic 23 E2E — skill dependency deploy (#1542)", () => {
  let root: string;
  let home: string;
  let releasesTmp: string;
  let registry: Awaited<ReturnType<typeof startRegistry>>;
  let staged: StagedFixture;
  let npmLog: string;
  let npmWrapper: string;
  let healthCalls: Array<{ home: string; since: number; timeout: number }>;

  const healthMock: typeof healthProbe = (h, since, timeoutMs = 180_000) => {
    healthCalls.push({ home: h, since, timeout: timeoutMs });
    return Promise.resolve({ healthy: true, pid: 9999, heartbeat: Date.now() });
  };

  function runDeploy(commit: string): Promise<number> {
    return deployActivation(
      {
        staged: {
          version: "9.9.9-e2e",
          commit,
          branch: "dev",
          stagedPath: staged.stagedPath,
          packageLockHash: null,
          source: "dev",
        } as StagedRelease,
        channel: "dev",
        repoRoot: root,
      },
      undefined,
      healthMock,
      () => ({ ok: true }),
      () => {},
    );
  }

  /** Real nested ESM import from the deployed skill's scripts dir. */
  function nestedImport(skillScriptsDir: string, pkg: string): { ok: boolean; value?: string } {
    const script = join(skillScriptsDir, "import-probe.mjs");
    writeFileSync(script, `import { VALUE } from ${JSON.stringify(pkg)}; console.log(VALUE);\n`);
    const r = spawnSync(process.execPath, [script], { cwd: skillScriptsDir, stdio: "pipe", timeout: 20_000 });
    rmSync(script);
    if (r.error || r.status !== 0) return { ok: false };
    return { ok: true, value: r.stdout.toString().trim() };
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "skill-dep-e2e-"));
    home = join(root, "abtars-home");
    releasesTmp = join(root, "releases");
    mkdirSync(home, { recursive: true });
    mkdirSync(releasesTmp, { recursive: true });
    process.env.ABTARS_HOME = home;
    process.env.ABTARS_RELEASES = releasesTmp;

    // Neutral fixture package (two exact versions) packed locally.
    const pkg = { name: "fixture-pkg", versions: new Map<string, string>() };
    pkg.versions.set("1.0.0", writeFixturePackage(root, "fixture-pkg", "1.0.0"));
    pkg.versions.set("2.0.0", writeFixturePackage(root, "fixture-pkg", "2.0.0"));
    registry = await startRegistry([pkg]);

    npmLog = join(root, "npm-argv.log");
    npmWrapper = join(root, "npm-wrapper");
    writeNpmWrapper(npmWrapper, npmLog);
    process.env.ABTARS_SKILL_NPM_BIN = npmWrapper;
    process.env.ABTARS_SKILL_NPM_REGISTRY = registry.url;

    staged = makeStagedRelease(root, "1.0.0");
  });

  afterAll(() => {
    registry?.close();
    delete process.env.ABTARS_HOME;
    delete process.env.ABTARS_RELEASES;
    delete process.env.ABTARS_SKILL_NPM_BIN;
    delete process.env.ABTARS_SKILL_NPM_REGISTRY;
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    healthCalls = [];
  });

  it("journey 1: fresh home — declares, installs, activates, reconciles, nested ESM import", { timeout: TIMEOUT }, async () => {
    // Non-first-install state (manifest present, prior history).
    writeFileSync(join(home, "manifest.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(releasesTmp, "history.json"), JSON.stringify(["prev-version"]));

    const code = await runDeploy("e2e-commit");

    expect(code).toBe(0);
    // 1. Exact pin under the dependency root.
    const installed = JSON.parse(readFileSync(join(home, "node_modules", "fixture-pkg", "package.json"), "utf-8")) as { version: string };
    expect(installed.version).toBe("1.0.0");
    // 2. Release activated + history updated.
    expect(existsSync(staged.releaseDir)).toBe(true);
    expect(readFileSync(join(releasesTmp, "history.json"), "utf-8")).toContain("e2e-commit");
    expect(existsSync(join(releasesTmp, "current"))).toBe(true);
    // 3. Reconcile copied staged core into the runtime tree.
    expect(existsSync(join(home, "skills", "core", "fixture-skill", "SKILL.md"))).toBe(true);
    // 4. Real nested ESM resolution from the deployed nested script path.
    const probe = nestedImport(join(home, "skills", "core", "fixture-skill", "scripts"), "fixture-pkg");
    expect(probe.ok).toBe(true);
    expect(probe.value).toBe("fixture-pkg-1.0.0");
    // Evidence.
    console.log(`[e2e] fresh: home=${home} staged=${staged.stagedPath} pin=fixture-pkg@${installed.version} import=${probe.value}`);
    expect(readFileSync(npmLog, "utf-8")).toContain("fixture-pkg@1.0.0");
  });

  it("journey 2: repeat deploy — identical pin, no npm invocation", { timeout: TIMEOUT }, async () => {
    const before = registry.hits();
    const npmCallsBefore = readFileSync(npmLog, "utf-8").trim().split("\n").filter(Boolean).length;
    const code = await runDeploy("e2e-commit");
    expect(code).toBe(0);
    // No packument/tarball traffic and no npm process on the repeat.
    expect(registry.hits()).toEqual(before);
    expect(readFileSync(npmLog, "utf-8").trim().split("\n").filter(Boolean)).toHaveLength(npmCallsBefore);
    console.log(`[e2e] repeat: npm invoked=${npmCallsBefore} registry hits unchanged`);
  });

  it("journey 3: drift — declared 2.0.0 repairs the direct pin and the import", { timeout: TIMEOUT }, async () => {
    staged.writeDeclaredVersion("2.0.0");
    const npmCallsBefore = readFileSync(npmLog, "utf-8").trim().split("\n").filter(Boolean).length;
    const code = await runDeploy("e2e-commit");
    expect(code).toBe(0);
    const installed = JSON.parse(readFileSync(join(home, "node_modules", "fixture-pkg", "package.json"), "utf-8")) as { version: string };
    expect(installed.version).toBe("2.0.0");
    expect(readFileSync(npmLog, "utf-8").trim().split("\n").filter(Boolean).length).toBeGreaterThan(npmCallsBefore);
    const probe = nestedImport(join(home, "skills", "core", "fixture-skill", "scripts"), "fixture-pkg");
    expect(probe.ok).toBe(true);
    expect(probe.value).toBe("fixture-pkg-2.0.0");
    console.log(`[e2e] drift: pin=fixture-pkg@${installed.version} import=${probe.value}`);
  });

  it("journey 4: conflicting declarations abort before activation, history untouched", { timeout: TIMEOUT }, async () => {
    // Second staged core skill conflicts on the shared root.
    const conflicter = join(staged.stagedPath, "templates", "skills", "conflict-skill");
    mkdirSync(join(conflicter, "scripts"), { recursive: true });
    writeFileSync(join(conflicter, "SKILL.md"), `---
name: conflict-skill
description: Conflicting pin
---
# Conflict
`);
    writeFileSync(join(conflicter, "scripts", "package.json"), JSON.stringify({ dependencies: { "fixture-pkg": "1.0.0" } }));

    const historyBefore = readFileSync(join(releasesTmp, "history.json"), "utf-8");
    const currentTargetBefore = readlinkSync(join(releasesTmp, "current"));
    const code = await runDeploy("conflict-commit");
    expect(code).toBe(1);
    // Activation never happened: no new release dir, the canonical link still
    // points at the previous release, no history mutation, no npm process.
    expect(existsSync(join(releasesTmp, "conflict-commit"))).toBe(false);
    expect(readlinkSync(join(releasesTmp, "current"))).toBe(currentTargetBefore);
    expect(readFileSync(join(releasesTmp, "history.json"), "utf-8")).toBe(historyBefore);
    expect(healthCalls).toHaveLength(0);
    const installed = JSON.parse(readFileSync(join(home, "node_modules", "fixture-pkg", "package.json"), "utf-8")) as { version: string };
    expect(installed.version).toBe("2.0.0"); // untouched by the aborted release
    console.log(`[e2e] abort: code=${code} release=${existsSync(join(releasesTmp, "conflict-commit"))} history unchanged=${readFileSync(join(releasesTmp, "history.json"), "utf-8") === historyBefore}`);
  });
});
