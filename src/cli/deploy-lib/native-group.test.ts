import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
