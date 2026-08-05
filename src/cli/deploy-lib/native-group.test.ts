import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NativePackageRecord } from "./shared-native-deps-types.js";
import { nativeTargetProbeId } from "./native-dep-targets.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ng-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── hashContent ──────────────────────────────────────────────────────────────

describe("hashContent", () => {
  it("returns empty string for non-existent directory", async () => {
    const { hashContent } = await import("./native-group.js");
    expect(hashContent(join(tmpDir, "nope"))).toBe("");
  });

  it("produces deterministic 16-char hex hash", async () => {
    const { hashContent } = await import("./native-group.js");
    const d = join(tmpDir, "pkg");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "a.js"), "hello");
    writeFileSync(join(d, "b.js"), "world");
    const h1 = hashContent(d);
    const h2 = hashContent(d);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
    expect(h1).toMatch(/^[0-9a-f]+$/);
  });
});

// ── nativeClosureProbeId ────────────────────────────────────────────────────

describe("nativeClosureProbeId", () => {
  it("returns a stable probe ID with the contract hash", async () => {
    const { nativeClosureProbeId } = await import("./native-group.js");
    const id = nativeClosureProbeId();
    expect(id).toMatch(/^native-closure:native-v1-/);
    expect(id).not.toContain("undefined");
    expect(nativeClosureProbeId()).toBe(nativeClosureProbeId());
  });
});

// ── resolveClosure ──────────────────────────────────────────────────────────

describe("resolveClosure", () => {
  it("resolves a flat two-root closure", async () => {
    const { resolveClosure } = await import("./native-group.js");
    const nm = join(tmpDir, "node_modules");
    mkdirSync(join(nm, "better-sqlite3"), { recursive: true });
    mkdirSync(join(nm, "sqlite-vec"), { recursive: true });
    writeFileSync(join(nm, "better-sqlite3", "package.json"), JSON.stringify({ name: "better-sqlite3", version: "12.11.1" }));
    writeFileSync(join(nm, "sqlite-vec", "package.json"), JSON.stringify({ name: "sqlite-vec", version: "0.1.9" }));

    const result = resolveClosure(nm, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
    const names = result.entries.map(e => e.name).sort();
    expect(names).toEqual(["better-sqlite3", "sqlite-vec"]);
    expect(result.entries.every(e => e.kind === "root")).toBe(true);
    expect(result.entries.every(e => e.contentHash.length === 16)).toBe(true);
  });

  it("resolves transitive deps from dependencies and optionalDependencies", async () => {
    const { resolveClosure } = await import("./native-group.js");
    const nm = join(tmpDir, "node_modules");
    mkdirSync(join(nm, "root-a"), { recursive: true });
    mkdirSync(join(nm, "root-b"), { recursive: true });
    mkdirSync(join(nm, "transitive"), { recursive: true });
    writeFileSync(join(nm, "root-a", "package.json"), JSON.stringify({
      name: "root-a", version: "1.0.0",
      dependencies: { transitive: "^1.0.0" },
    }));
    writeFileSync(join(nm, "root-b", "package.json"), JSON.stringify({
      name: "root-b", version: "2.0.0",
      optionalDependencies: { transitive: "^1.0.0" },
    }));
    writeFileSync(join(nm, "transitive", "package.json"), JSON.stringify({ name: "transitive", version: "1.1.0" }));

    const result = resolveClosure(nm, ["root-a", "root-b"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(3);
    const trans = result.entries.find(e => e.name === "transitive");
    expect(trans).toBeDefined();
    expect(trans!.kind).toBe("transitive");
    expect(trans!.version).toBe("1.1.0");
  });

  it("deduplicates transitive packages from multiple roots with distinct overlapping ranges", async () => {
    const { resolveClosure } = await import("./native-group.js");
    const nm = join(tmpDir, "node_modules");
    mkdirSync(join(nm, "root-a"), { recursive: true });
    mkdirSync(join(nm, "root-b"), { recursive: true });
    mkdirSync(join(nm, "shared"), { recursive: true });
    writeFileSync(join(nm, "root-a", "package.json"), JSON.stringify({
      name: "root-a", version: "1.0.0",
      dependencies: { shared: "^1.0.0" },
    }));
    writeFileSync(join(nm, "root-b", "package.json"), JSON.stringify({
      name: "root-b", version: "2.0.0",
      dependencies: { shared: "^1.5.0" },
    }));
    writeFileSync(join(nm, "shared", "package.json"), JSON.stringify({ name: "shared", version: "1.5.0" }));

    const result = resolveClosure(nm, ["root-a", "root-b"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(3);
    const shared = result.entries.find(e => e.name === "shared");
    expect(shared).toBeDefined();
    expect(shared!.kind).toBe("transitive");
  });

  it("fails when a root package is missing", async () => {
    const { resolveClosure } = await import("./native-group.js");
    const nm = join(tmpDir, "node_modules");
    mkdirSync(join(nm, "better-sqlite3"), { recursive: true });
    writeFileSync(join(nm, "better-sqlite3", "package.json"), JSON.stringify({ name: "better-sqlite3", version: "12.11.1" }));

    const result = resolveClosure(nm, ["better-sqlite3", "sqlite-vec"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("sqlite-vec");
  });

  it("fails on malformed package.json", async () => {
    const { resolveClosure } = await import("./native-group.js");
    const nm = join(tmpDir, "node_modules");
    mkdirSync(join(nm, "bad-pkg"), { recursive: true });
    writeFileSync(join(nm, "bad-pkg", "package.json"), "not json");

    const result = resolveClosure(nm, ["bad-pkg"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Cannot read or parse");
  });

  it("fails when package.json has no version", async () => {
    const { resolveClosure } = await import("./native-group.js");
    const nm = join(tmpDir, "node_modules");
    mkdirSync(join(nm, "no-ver"), { recursive: true });
    writeFileSync(join(nm, "no-ver", "package.json"), JSON.stringify({ name: "no-ver" }));

    const result = resolveClosure(nm, ["no-ver"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Missing or invalid");
  });

  it("accepts distinct range strings — range diversity is not a collision", async () => {
    const { resolveClosure } = await import("./native-group.js");
    const nm = join(tmpDir, "node_modules");
    mkdirSync(join(nm, "root-a"), { recursive: true });
    mkdirSync(join(nm, "root-b"), { recursive: true });
    mkdirSync(join(nm, "shared"), { recursive: true });
    writeFileSync(join(nm, "root-a", "package.json"), JSON.stringify({
      name: "root-a", version: "1.0.0",
      dependencies: { shared: "^1.0.0" },
    }));
    writeFileSync(join(nm, "root-b", "package.json"), JSON.stringify({
      name: "root-b", version: "2.0.0",
      dependencies: { shared: "^2.0.0" },
    }));
    writeFileSync(join(nm, "shared", "package.json"), JSON.stringify({ name: "shared", version: "1.5.0" }));

    const result = resolveClosure(nm, ["root-a", "root-b"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries.some(e => e.name === "shared")).toBe(true);
    }
  });

  it("skips missing optionalDependencies packages", async () => {
    const { resolveClosure } = await import("./native-group.js");
    const nm = join(tmpDir, "node_modules");
    mkdirSync(join(nm, "root"), { recursive: true });
    mkdirSync(join(nm, "present-transitive"), { recursive: true });
    writeFileSync(join(nm, "root", "package.json"), JSON.stringify({
      name: "root", version: "1.0.0",
      dependencies: { "present-transitive": "^1.0.0" },
      optionalDependencies: { "missing-optional": "^1.0.0" },
    }));
    writeFileSync(join(nm, "present-transitive", "package.json"), JSON.stringify({ name: "present-transitive", version: "1.0.0" }));

    const result = resolveClosure(nm, ["root"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
    expect(result.entries.some(e => e.name === "present-transitive")).toBe(true);
    expect(result.entries.some(e => e.name === "missing-optional")).toBe(false);
  });

  it("produces deterministic name ordering", async () => {
    const { resolveClosure } = await import("./native-group.js");
    const nm = join(tmpDir, "node_modules");
    mkdirSync(join(nm, "z-final"), { recursive: true });
    mkdirSync(join(nm, "a-first"), { recursive: true });
    mkdirSync(join(nm, "m-middle"), { recursive: true });
    for (const pkg of ["a-first", "m-middle", "z-final"]) {
      writeFileSync(join(nm, pkg, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0" }));
    }

    const result = resolveClosure(nm, ["z-final", "a-first", "m-middle"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.entries.map(e => e.name);
    expect(names).toEqual(["a-first", "m-middle", "z-final"]);
  });

  it("rejects packages outside the shared root", async () => {
    const { resolveClosure } = await import("./native-group.js");
    const nm = join(tmpDir, "node_modules");
    const escapeTarget = join(tmpDir, "escape-target");
    mkdirSync(escapeTarget, { recursive: true });
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(escapeTarget, "package.json"), JSON.stringify({ name: "escape", version: "99.0.0" }));
    try {
      symlinkSync(escapeTarget, join(nm, "escape"), "junction");
    } catch {
      return;
    }

    const result = resolveClosure(nm, ["escape"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("escapes");
  });
});

// ── selectNativeGroupAction ────────────────────────────────────────────────

describe("selectNativeGroupAction", () => {
  type Obs = Parameters<typeof import("./native-group.js")["selectNativeGroupAction"]>[1];

  const makeObs = (overrides: Partial<Obs>): Obs => ({
    packages: [],
    state: "absent" as const,
    adoption: { eligible: false },
    ...overrides,
  });

  const makeAdoptableObs = (state: Obs["state"]): Obs => makeObs({
    state,
    adoption: { eligible: true, closure: [] },
  });

  it("install + ready → reuse", async () => {
    const { selectNativeGroupAction } = await import("./native-group.js");
    expect(selectNativeGroupAction("install", makeObs({ state: "ready" }))).toBe("reuse");
  });

  it("install + drifted + eligible → adopt", async () => {
    const { selectNativeGroupAction } = await import("./native-group.js");
    expect(selectNativeGroupAction("install", makeAdoptableObs("drifted"))).toBe("adopt");
  });

  it("install + drifted + not eligible → repair", async () => {
    const { selectNativeGroupAction } = await import("./native-group.js");
    expect(selectNativeGroupAction("install", makeObs({ state: "drifted" }))).toBe("repair");
  });

  it("install + absent → repair", async () => {
    const { selectNativeGroupAction } = await import("./native-group.js");
    expect(selectNativeGroupAction("install", makeObs({ state: "absent" }))).toBe("repair");
  });

  it("install + partial → repair", async () => {
    const { selectNativeGroupAction } = await import("./native-group.js");
    expect(selectNativeGroupAction("install", makeObs({ state: "partial" }))).toBe("repair");
  });

  it("install + invalid → repair", async () => {
    const { selectNativeGroupAction } = await import("./native-group.js");
    expect(selectNativeGroupAction("install", makeObs({ state: "invalid" }))).toBe("repair");
  });

  it("update + absent → instruct-install", async () => {
    const { selectNativeGroupAction } = await import("./native-group.js");
    expect(selectNativeGroupAction("update", makeObs({ state: "absent" }))).toBe("instruct-install");
  });

  it("update + ready → refresh", async () => {
    const { selectNativeGroupAction } = await import("./native-group.js");
    expect(selectNativeGroupAction("update", makeObs({ state: "ready" }))).toBe("refresh");
  });

  it("update + drifted + eligible → adopt", async () => {
    const { selectNativeGroupAction } = await import("./native-group.js");
    expect(selectNativeGroupAction("update", makeAdoptableObs("drifted"))).toBe("adopt");
  });

  it("update + drifted + not eligible → repair", async () => {
    const { selectNativeGroupAction } = await import("./native-group.js");
    expect(selectNativeGroupAction("update", makeObs({ state: "drifted" }))).toBe("repair");
  });

  it("update + partial → repair", async () => {
    const { selectNativeGroupAction } = await import("./native-group.js");
    expect(selectNativeGroupAction("update", makeObs({ state: "partial" }))).toBe("repair");
  });

  it("update + invalid → repair", async () => {
    const { selectNativeGroupAction } = await import("./native-group.js");
    expect(selectNativeGroupAction("update", makeObs({ state: "invalid" }))).toBe("repair");
  });
});

// ── observeNativeGroup (uses AB_SHARED_DEPS_ROOT instead of homedir) ──────

describe("observeNativeGroup", () => {
  beforeEach(() => {
    process.env["AB_SHARED_DEPS_ROOT"] = tmpDir;
  });

  afterEach(() => {
    delete process.env["AB_SHARED_DEPS_ROOT"];
  });

  it("returns absent when no packages exist", async () => {
    const { observeNativeGroup } = await import("./native-group.js");
    const obs = observeNativeGroup();
    expect(obs.state).toBe("absent");
    expect(obs.adoption).toEqual({ eligible: false });
  });

  it("returns drifted when both roots exist at target but no manifest", async () => {
    const nm = join(tmpDir, "node_modules");
    mkdirSync(join(nm, "better-sqlite3"), { recursive: true });
    mkdirSync(join(nm, "sqlite-vec"), { recursive: true });
    writeFileSync(join(nm, "better-sqlite3", "package.json"), JSON.stringify({ name: "better-sqlite3", version: "12.11.1" }));
    writeFileSync(join(nm, "sqlite-vec", "package.json"), JSON.stringify({ name: "sqlite-vec", version: "0.1.9" }));

    const { observeNativeGroup } = await import("./native-group.js");
    const obs = observeNativeGroup();
    expect(obs.state).toBe("drifted");
  });

  it("returns drifted when only one root exists (partial install)", async () => {
    const nm = join(tmpDir, "node_modules");
    mkdirSync(join(nm, "better-sqlite3"), { recursive: true });
    writeFileSync(join(nm, "better-sqlite3", "package.json"), JSON.stringify({ name: "better-sqlite3", version: "12.11.1" }));

    const { observeNativeGroup } = await import("./native-group.js");
    const obs = observeNativeGroup();
    expect(obs.state).toBe("drifted");
  });

  it("returns invalid when a package.json is malformed", async () => {
    const nm = join(tmpDir, "node_modules");
    mkdirSync(join(nm, "better-sqlite3"), { recursive: true });
    mkdirSync(join(nm, "sqlite-vec"), { recursive: true });
    writeFileSync(join(nm, "better-sqlite3", "package.json"), "not json");
    writeFileSync(join(nm, "sqlite-vec", "package.json"), JSON.stringify({ name: "sqlite-vec", version: "0.1.9" }));

    const { observeNativeGroup } = await import("./native-group.js");
    const obs = observeNativeGroup();
    expect(obs.state).toBe("invalid");
  });
});

// ── #1514: closure freshness / ownership boundary ─────────────────────────────

function writeStubPkg(dir: string, name: string, version: string, deps?: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  const meta: Record<string, unknown> = { name, version, main: "index.js" };
  if (deps) meta.dependencies = deps;
  writeFileSync(join(dir, "package.json"), JSON.stringify(meta));
  const body = name === "better-sqlite3"
    ? "module.exports = function Database() { return { exec() {}, close() {} }; };\n"
    : name === "sqlite-vec"
      ? "module.exports = { load() {} };\n"
      : "module.exports = {};\n";
  writeFileSync(join(dir, "index.js"), body);
}

function seedCompleteRootsWithTransitive(nm: string, nodeAbiVersion = "3.92.0"): void {
  writeStubPkg(join(nm, "better-sqlite3"), "better-sqlite3", "12.11.1", { "node-abi": "^3.92.0" });
  writeStubPkg(join(nm, "sqlite-vec"), "sqlite-vec", "0.1.9");
  writeStubPkg(join(nm, "node-abi"), "node-abi", nodeAbiVersion);
}

async function probeFor(name: string, kind: "root" | "transitive"): Promise<string> {
  if (kind === "root") return nativeTargetProbeId(name as "better-sqlite3" | "sqlite-vec");
  const { nativeClosureProbeId } = await import("./native-group.js");
  return nativeClosureProbeId();
}

async function writeFullManifest(nm: string, nodeAbiRecord?: (r: NativePackageRecord) => void): Promise<void> {
  const { resolveClosure } = await import("./native-group.js");
  const { createEmptyManifest, writeManifest, upsertRecord } = await import("./shared-native-deps-manifest.js");
  const closure = resolveClosure(nm, ["better-sqlite3", "sqlite-vec"]);
  if (!closure.ok) throw new Error(`fixture closure failed: ${closure.reason}`);
  let m = createEmptyManifest();
  for (const e of closure.entries) {
    const rec: NativePackageRecord = {
      version: e.version,
      nodeAbi: process.versions?.modules ?? "",
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      contentHash: e.contentHash,
      installedAt: new Date().toISOString(),
      installedBy: "abtars",
      consumers: ["abtars"],
      probe: await probeFor(e.name, e.kind),
    };
    if (e.name === "node-abi" && nodeAbiRecord) nodeAbiRecord(rec);
    m = upsertRecord(m, e.name, rec);
  }
  writeManifest(m);
}

describe("observeNativeGroup closure freshness (#1514)", () => {
  beforeEach(() => {
    process.env["AB_SHARED_DEPS_ROOT"] = tmpDir;
  });

  afterEach(() => {
    delete process.env["AB_SHARED_DEPS_ROOT"];
  });

  it.each([
    ["fresh transitive record", true, (r: NativePackageRecord) => { void r; }],
    ["stale transitive version", false, (r: NativePackageRecord) => { r.version = "3.91.0"; }],
    ["stale transitive contentHash", false, (r: NativePackageRecord) => { r.contentHash = "deadbeefdeadbeef"; }],
    ["stale transitive runtime ABI", false, (r: NativePackageRecord) => { r.nodeAbi = "999"; }],
  ] as Array<[string, boolean, (r: NativePackageRecord) => void]>)("observes %s", async (_label, expectReady, mutate) => {
    const nm = join(tmpDir, "node_modules");
    mkdirSync(nm, { recursive: true });
    seedCompleteRootsWithTransitive(nm);
    await writeFullManifest(nm, mutate);

    const { observeNativeGroup } = await import("./native-group.js");
    expect(observeNativeGroup().state).toBe(expectReady ? "ready" : "drifted");
  });

  it("reports drifted when the transitive record is missing", async () => {
    const nm = join(tmpDir, "node_modules");
    mkdirSync(nm, { recursive: true });
    seedCompleteRootsWithTransitive(nm);
    await writeFullManifest(nm, () => {});
    const { readManifest, writeManifest } = await import("./shared-native-deps-manifest.js");
    const m = readManifest();
    if (m) {
      delete m.packages["node-abi"];
      writeManifest(m);
    }

    const { observeNativeGroup } = await import("./native-group.js");
    expect(observeNativeGroup().state).toBe("drifted");
  });

  it("reports drifted when the transitive record carries a foreign marker", async () => {
    const nm = join(tmpDir, "node_modules");
    mkdirSync(nm, { recursive: true });
    seedCompleteRootsWithTransitive(nm);
    await writeFullManifest(nm, r => { r.probe = "native-closure:foreign-hash"; });

    const { observeNativeGroup } = await import("./native-group.js");
    expect(observeNativeGroup().state).toBe("drifted");
  });
});

// ── #1514: adoption boundary (probe-satisfying stubs) ─────────────────────────

describe("ensureNativeGroup adoption of stale marker-owned closure (#1514)", () => {
  beforeEach(() => {
    process.env["AB_SHARED_DEPS_ROOT"] = tmpDir;
  });

  afterEach(() => {
    delete process.env["AB_SHARED_DEPS_ROOT"];
  });

  it("adopts a complete stale marker-owned closure without npm or byte mutation", async () => {
    const nm = join(tmpDir, "node_modules");
    mkdirSync(nm, { recursive: true });
    seedCompleteRootsWithTransitive(nm);
    await writeFullManifest(nm, r => { r.version = "3.91.0"; });
    const nodeAbiLive = readFileSync(join(nm, "node-abi", "index.js"), "utf-8");
    const preManifest = readFileSync(join(tmpDir, "native-deps.manifest.json"), "utf-8");

    const { ensureNativeGroup, observeNativeGroup } = await import("./native-group.js");
    const result = ensureNativeGroup("abtars", "install");

    expect(result.ok).toBe(true);
    expect(result.action).toBe("reuse");
    const { readManifest } = await import("./shared-native-deps-manifest.js");
    const m = readManifest();
    expect(m?.packages["node-abi"]?.version).toBe("3.92.0");
    expect(readFileSync(join(nm, "node-abi", "index.js"), "utf-8")).toBe(nodeAbiLive);
    expect(observeNativeGroup().state).toBe("ready");
    expect(readFileSync(join(tmpDir, "native-deps.manifest.json"), "utf-8")).not.toBe(preManifest);
  });

  it("adopting a foreign-marker transitive fails without mutating manifest or live bytes", async () => {
    const nm = join(tmpDir, "node_modules");
    mkdirSync(nm, { recursive: true });
    seedCompleteRootsWithTransitive(nm);
    await writeFullManifest(nm, r => { r.probe = "native-closure:foreign-hash"; });
    const preManifest = readFileSync(join(tmpDir, "native-deps.manifest.json"), "utf-8");

    const { ensureNativeGroup } = await import("./native-group.js");
    const result = ensureNativeGroup("abtars", "install");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("non-native-closure probe");
    expect(readFileSync(join(tmpDir, "native-deps.manifest.json"), "utf-8")).toBe(preManifest);
  });
});

// ── #1514: staged repair / refresh collision boundary (fake npm) ──────────────

async function writeRepairManifest(nm: string, nodeAbiRecord?: (r: NativePackageRecord) => void): Promise<void> {
  const { hashContent } = await import("./native-group.js");
  const { createEmptyManifest, writeManifest, upsertRecord } = await import("./shared-native-deps-manifest.js");
  let m = createEmptyManifest();
  const rootRec: NativePackageRecord = {
    version: "12.11.1",
    nodeAbi: process.versions?.modules ?? "",
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    contentHash: hashContent(join(nm, "better-sqlite3")),
    installedAt: new Date().toISOString(),
    installedBy: "abtars",
    consumers: ["abtars"],
    probe: nativeTargetProbeId("better-sqlite3"),
  };
  m = upsertRecord(m, "better-sqlite3", rootRec);
  if (nodeAbiRecord) {
    const rec: NativePackageRecord = {
      version: "3.92.0",
      nodeAbi: process.versions?.modules ?? "",
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      contentHash: hashContent(join(nm, "node-abi")),
      installedAt: new Date().toISOString(),
      installedBy: "abtars",
      consumers: ["abtars"],
      probe: await probeFor("node-abi", "transitive"),
    };
    nodeAbiRecord(rec);
    m = upsertRecord(m, "node-abi", rec);
  }
  writeManifest(m);
}

function writeFakeNpm(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const i = args.indexOf("--prefix");
const prefix = args[i + 1];
if (!prefix) process.exit(1);
const nm = path.join(prefix, "node_modules");
fs.mkdirSync(nm, { recursive: true });
function pkg(name, version, deps) {
  const dir = path.join(nm, name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { name, version, main: "index.js" };
  if (deps) meta.dependencies = deps;
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, "index.js"),
    name === "better-sqlite3"
      ? "module.exports = function Database() { return { exec() {}, close() {} }; };\\n"
      : name === "sqlite-vec"
        ? "module.exports = { load() {} };\\n"
        : "module.exports = {};\\n");
}
pkg("better-sqlite3", "12.11.1", { "node-abi": "^3.94.0" });
pkg("sqlite-vec", "0.1.9");
const transitive = process.env.FAKE_NPM_TRANSITIVE;
if (transitive) {
  const [tname, tver] = transitive.split("@");
  pkg(tname, tver);
}
`;
  const p = join(binDir, "npm");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

describe("ensureNativeGroup staged repair/refresh (#1514)", () => {
  let savedPath: string | undefined;

  beforeEach(() => {
    process.env["AB_SHARED_DEPS_ROOT"] = tmpDir;
    savedPath = process.env["PATH"];
    writeFakeNpm(join(tmpDir, "fake-bin"));
    process.env["PATH"] = join(tmpDir, "fake-bin") + (savedPath ? `:${savedPath}` : "");
  });

  afterEach(() => {
    if (savedPath !== undefined) process.env["PATH"] = savedPath;
    delete process.env["AB_SHARED_DEPS_ROOT"];
    delete process.env["FAKE_NPM_TRANSITIVE"];
  });

  it("replaces a stale marker-owned transitive during partial-root repair", async () => {
    const nm = join(tmpDir, "node_modules");
    mkdirSync(nm, { recursive: true });
    writeStubPkg(join(nm, "better-sqlite3"), "better-sqlite3", "12.11.1", { "node-abi": "^3.92.0" });
    writeStubPkg(join(nm, "node-abi"), "node-abi", "3.92.0");
    await writeRepairManifest(nm, r => { r.version = "3.91.0"; });
    process.env["FAKE_NPM_TRANSITIVE"] = "node-abi@3.94.0";

    const { ensureNativeGroup, observeNativeGroup } = await import("./native-group.js");
    const result = ensureNativeGroup("abtars", "install");

    expect(result.ok).toBe(true);
    expect(result.action).toBe("repair");
    expect(readFileSync(join(nm, "node-abi", "package.json"), "utf-8")).toContain("3.94.0");
    const { readManifest } = await import("./shared-native-deps-manifest.js");
    expect(readManifest()?.packages["node-abi"]?.version).toBe("3.94.0");
    expect(observeNativeGroup().state).toBe("ready");
  });

  it("refuses an untracked transitive as a hard collision and preserves live bytes", async () => {
    const nm = join(tmpDir, "node_modules");
    mkdirSync(nm, { recursive: true });
    writeStubPkg(join(nm, "better-sqlite3"), "better-sqlite3", "12.11.1", { "node-abi": "^3.92.0" });
    writeStubPkg(join(nm, "node-abi"), "node-abi", "3.92.0");
    await writeRepairManifest(nm);
    const preManifest = readFileSync(join(tmpDir, "native-deps.manifest.json"), "utf-8");
    process.env["FAKE_NPM_TRANSITIVE"] = "node-abi@3.94.0";

    const { ensureNativeGroup } = await import("./native-group.js");
    const result = ensureNativeGroup("abtars", "install");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Collision with unrelated package");
    expect(result.error).toContain("node-abi");
    expect(readFileSync(join(nm, "node-abi", "package.json"), "utf-8")).toContain("3.92.0");
    expect(readFileSync(join(tmpDir, "native-deps.manifest.json"), "utf-8")).toBe(preManifest);
  });

  it("refuses a foreign-marker transitive as a hard collision and preserves live bytes", async () => {
    const nm = join(tmpDir, "node_modules");
    mkdirSync(nm, { recursive: true });
    writeStubPkg(join(nm, "better-sqlite3"), "better-sqlite3", "12.11.1", { "node-abi": "^3.92.0" });
    writeStubPkg(join(nm, "node-abi"), "node-abi", "3.92.0");
    await writeRepairManifest(nm, r => { r.probe = "native-closure:foreign-hash"; });
    const preManifest = readFileSync(join(tmpDir, "native-deps.manifest.json"), "utf-8");
    process.env["FAKE_NPM_TRANSITIVE"] = "node-abi@3.94.0";

    const { ensureNativeGroup } = await import("./native-group.js");
    const result = ensureNativeGroup("abtars", "install");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Collision with unrelated package");
    expect(readFileSync(join(nm, "node-abi", "package.json"), "utf-8")).toContain("3.92.0");
    expect(readFileSync(join(tmpDir, "native-deps.manifest.json"), "utf-8")).toBe(preManifest);
  });

  it("refresh on a fresh closure replaces a registry-drifted marker-owned transitive", async () => {
    const nm = join(tmpDir, "node_modules");
    mkdirSync(nm, { recursive: true });
    seedCompleteRootsWithTransitive(nm);
    await writeFullManifest(nm, () => {});
    process.env["FAKE_NPM_TRANSITIVE"] = "node-abi@3.94.0";

    const { ensureNativeGroup, observeNativeGroup } = await import("./native-group.js");
    const result = ensureNativeGroup("abtars", "update");

    expect(result.ok).toBe(true);
    expect(result.action).toBe("refresh");
    expect(readFileSync(join(nm, "node-abi", "package.json"), "utf-8")).toContain("3.94.0");
    const { readManifest } = await import("./shared-native-deps-manifest.js");
    expect(readManifest()?.packages["node-abi"]?.version).toBe("3.94.0");
    expect(observeNativeGroup().state).toBe("ready");
  });
});
